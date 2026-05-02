# -*- coding: utf-8 -*-
"""
群組（Group）Blueprint
路由：/api/groups...

群組用來把幾個人綁在一起：
  - permanent（家庭、合夥關係，永久存在）
  - temporary（一場交易、一次看屋小組，事件結束就封存）

Firestore 結構：
  people_groups/{group_id}
"""

import logging

from flask import Blueprint, request, jsonify

from auth import require_user
from firestore_client import get_db, server_timestamp


bp = Blueprint("groups", __name__)


VALID_GROUP_TYPES = {"permanent", "temporary"}


def _str_or_none(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _doc_to_dict(doc):
    d = doc.to_dict() or {}
    d["id"] = doc.id
    for key in ("created_at", "updated_at", "archived_at"):
        v = d.get(key)
        if v is not None and hasattr(v, "isoformat"):
            d[key] = v.isoformat()
    return d


def _build_payload(data, email, is_create=True):
    name = _str_or_none(data.get("name"))
    if not name:
        return None, "group name 必填"
    gtype = _str_or_none(data.get("type")) or "temporary"
    if gtype not in VALID_GROUP_TYPES:
        return None, f"type 只能是 {VALID_GROUP_TYPES}"
    members = data.get("member_ids", [])
    if not isinstance(members, list):
        members = []
    members = [str(m).strip() for m in members if str(m).strip()]

    payload = {
        "name": name,
        "type": gtype,
        "description": _str_or_none(data.get("description")),
        "member_ids": members,
        "updated_at": server_timestamp(),
    }
    if is_create:
        payload["archived"] = False
        payload["archived_at"] = None
        payload["created_by"] = email
        payload["created_at"] = server_timestamp()
    return payload, None


def _validate_members_owned(db, member_ids, email):
    """驗證所有 member 都屬於該使用者。回傳 (ok, msg)。"""
    for mid in member_ids:
        snap = db.collection("people").document(mid).get()
        if not snap.exists:
            return False, f"成員 {mid} 不存在"
        if (snap.to_dict() or {}).get("created_by") != email:
            return False, f"成員 {mid} 不屬於你"
    return True, None


# ══════════════════════════════════════════
#  Routes
# ══════════════════════════════════════════

@bp.route("/api/groups", methods=["GET"])
def list_groups():
    """列表（自動過濾 archived，除非 ?include_archived=1）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    include_archived = request.args.get("include_archived") == "1"
    try:
        q = db.collection("people_groups").where("created_by", "==", email)
        docs = list(q.stream())
        items = [_doc_to_dict(d) for d in docs]
        if not include_archived:
            items = [x for x in items if not x.get("archived")]
        # 按 updated_at 降冪
        items.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("Groups list failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/groups/<gid>", methods=["GET"])
def get_group(gid):
    """取得單筆，含展開 members 的姓名/頭像（前端常用）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people_groups").document(gid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此群組"}), 404
        d = _doc_to_dict(snap)
        # 展開 members 的基本資料
        member_ids = d.get("member_ids", []) or []
        members_out = []
        for mid in member_ids:
            msnap = db.collection("people").document(mid).get()
            if msnap.exists and (msnap.to_dict() or {}).get("created_by") == email:
                md = msnap.to_dict() or {}
                if md.get("deleted_at"):
                    continue
                members_out.append({
                    "id": mid,
                    "name": md.get("name"),
                    "avatar_b64": md.get("avatar_b64"),
                    "active_roles": md.get("active_roles", []),
                })
        d["members"] = members_out
        return jsonify(d)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/groups", methods=["POST"])
def create_group():
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    payload, msg = _build_payload(data, email, is_create=True)
    if msg:
        return jsonify({"error": msg}), 400

    ok, msg2 = _validate_members_owned(db, payload["member_ids"], email)
    if not ok:
        return jsonify({"error": msg2}), 400

    try:
        ref = db.collection("people_groups").document()
        ref.set(payload)
        return jsonify(_doc_to_dict(ref.get())), 201
    except Exception as e:
        logging.warning("Group create failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/groups/<gid>", methods=["PUT"])
def update_group(gid):
    """更新群組（含成員增刪，整批替換）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    payload, msg = _build_payload(data, email, is_create=False)
    if msg:
        return jsonify({"error": msg}), 400

    try:
        ref = db.collection("people_groups").document(gid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此群組"}), 404
        ok, msg2 = _validate_members_owned(db, payload["member_ids"], email)
        if not ok:
            return jsonify({"error": msg2}), 400
        ref.update(payload)
        return jsonify(_doc_to_dict(ref.get()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/groups/<gid>", methods=["DELETE"])
def archive_group(gid):
    """封存群組（不刪除）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people_groups").document(gid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此群組"}), 404
        ref.update({
            "archived": True,
            "archived_at": server_timestamp(),
            "updated_at": server_timestamp(),
        })
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
