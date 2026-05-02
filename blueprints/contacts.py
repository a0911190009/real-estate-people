# -*- coding: utf-8 -*-
"""
互動記事 + 來時路（Timeline）Blueprint
路由：
  /api/people/<pid>/contacts        互動記事 CRUD
  /api/people/<pid>/timeline        來時路（合併 contacts + 標籤事件 + 狀態變更）

Firestore 結構：
  people/{pid}/contacts/{cid}       互動記事（使用者主動寫）
  people/{pid}/timeline/{eid}       事件流（系統自動寫，包含 contacts 寫入時也會同步寫一條）
"""

import logging

from flask import Blueprint, request, jsonify

from auth import require_user
from firestore_client import get_db, server_timestamp


bp = Blueprint("contacts", __name__)


VALID_VIA = {"phone", "line", "meet", "showing", "other"}


def _str_or_none(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _doc_to_dict(doc):
    d = doc.to_dict() or {}
    d["id"] = doc.id
    for key in ("contact_at", "created_at", "updated_at"):
        v = d.get(key)
        if v is not None and hasattr(v, "isoformat"):
            d[key] = v.isoformat()
    return d


def _person_owned(db, pid, email):
    """檢查 person 屬於該使用者，回傳 (ref, error_response)。"""
    ref = db.collection("people").document(pid)
    snap = ref.get()
    if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
        return None, (jsonify({"error": "找不到此人"}), 404)
    return ref, None


# ══════════════════════════════════════════
#  互動記事 CRUD
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/contacts", methods=["GET"])
def list_contacts(pid):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person_ref, errr = _person_owned(db, pid, email)
    if errr:
        return errr

    try:
        docs = list(person_ref.collection("contacts").stream())
        items = [_doc_to_dict(d) for d in docs]
        # 按 contact_at 降冪（最新在前）
        items.sort(key=lambda x: x.get("contact_at") or "", reverse=True)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("Contacts list failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/contacts", methods=["POST"])
def create_contact(pid):
    """
    新增互動記事。同時：
    1. 寫一條 timeline 事件
    2. 更新 person 的 last_contact_at
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person_ref, errr = _person_owned(db, pid, email)
    if errr:
        return errr

    data = request.get_json(silent=True) or {}
    content = _str_or_none(data.get("content"))
    if not content:
        return jsonify({"error": "content 必填"}), 400

    via = _str_or_none(data.get("via"))
    if via and via not in VALID_VIA:
        via = "other"

    # 互動時間（使用者可指定過去時間補記，否則用現在）
    contact_at_raw = _str_or_none(data.get("contact_at"))
    contact_at_field = contact_at_raw if contact_at_raw else server_timestamp()

    # @mention：[{person_id, name, start, end}]
    mentions_raw = data.get("mentions", [])
    mentions = []
    if isinstance(mentions_raw, list):
        for m in mentions_raw:
            if not isinstance(m, dict):
                continue
            pid = str(m.get("person_id", "") or "").strip()
            nm = str(m.get("name", "") or "").strip()
            if not pid:
                continue
            try:
                start = int(m.get("start", 0))
                end = int(m.get("end", 0))
            except (TypeError, ValueError):
                start, end = 0, 0
            mentions.append({"person_id": pid, "name": nm, "start": start, "end": end})

    payload = {
        "content": content,
        "via": via,
        "voice_recorded": bool(data.get("voice_recorded", False)),
        "attachments": data.get("attachments", []) if isinstance(data.get("attachments"), list) else [],
        "mentions": mentions,
        "contact_at": contact_at_field,
        "created_at": server_timestamp(),
        "created_by": email,
    }

    try:
        c_ref = person_ref.collection("contacts").document()
        c_ref.set(payload)
        # 同步寫 timeline
        person_ref.collection("timeline").add({
            "type": "contact_added",
            "display_text": (content[:50] + ("…" if len(content) > 50 else "")),
            "payload": {"contact_id": c_ref.id, "via": via, "voice_recorded": payload["voice_recorded"]},
            "occurred_at": contact_at_field,
            "created_by": email,
        })
        # 更新 last_contact_at
        person_ref.update({
            "last_contact_at": contact_at_field,
            "updated_at": server_timestamp(),
        })
        return jsonify(_doc_to_dict(c_ref.get())), 201
    except Exception as e:
        logging.warning("Contact create failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/contacts/<cid>", methods=["PUT"])
def update_contact(pid, cid):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person_ref, errr = _person_owned(db, pid, email)
    if errr:
        return errr

    data = request.get_json(silent=True) or {}
    content = _str_or_none(data.get("content"))
    if not content:
        return jsonify({"error": "content 必填"}), 400

    via = _str_or_none(data.get("via"))
    if via and via not in VALID_VIA:
        via = "other"

    try:
        c_ref = person_ref.collection("contacts").document(cid)
        if not c_ref.get().exists:
            return jsonify({"error": "找不到此互動記事"}), 404
        update = {
            "content": content,
            "updated_at": server_timestamp(),
        }
        if via is not None:
            update["via"] = via
        if data.get("contact_at"):
            update["contact_at"] = _str_or_none(data.get("contact_at"))
        # @mention：可選更新
        if "mentions" in data and isinstance(data["mentions"], list):
            mentions = []
            for m in data["mentions"]:
                if not isinstance(m, dict):
                    continue
                p_pid = str(m.get("person_id", "") or "").strip()
                nm = str(m.get("name", "") or "").strip()
                if not p_pid:
                    continue
                try:
                    start = int(m.get("start", 0))
                    end = int(m.get("end", 0))
                except (TypeError, ValueError):
                    start, end = 0, 0
                mentions.append({"person_id": p_pid, "name": nm, "start": start, "end": end})
            update["mentions"] = mentions
        c_ref.update(update)
        return jsonify(_doc_to_dict(c_ref.get()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/contacts/<cid>", methods=["DELETE"])
def delete_contact(pid, cid):
    """硬刪除互動記事（timeline 事件保留，因為已是歷史）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person_ref, errr = _person_owned(db, pid, email)
    if errr:
        return errr

    try:
        c_ref = person_ref.collection("contacts").document(cid)
        if not c_ref.get().exists:
            return jsonify({"error": "找不到此互動記事"}), 404
        c_ref.delete()
        person_ref.update({"updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  Timeline（來時路）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/timeline", methods=["GET"])
def get_timeline(pid):
    """
    取得此人完整來時路（事件流）。
    Query: limit（預設 200，上限 500）
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person_ref, errr = _person_owned(db, pid, email)
    if errr:
        return errr

    try:
        limit = min(int(request.args.get("limit", 200)), 500)
    except ValueError:
        limit = 200

    try:
        docs = list(person_ref.collection("timeline").limit(limit).stream())
        items = []
        for d in docs:
            data = d.to_dict() or {}
            data["id"] = d.id
            v = data.get("occurred_at")
            if v is not None and hasattr(v, "isoformat"):
                data["occurred_at"] = v.isoformat()
            items.append(data)
        # 按 occurred_at 降冪
        items.sort(key=lambda x: x.get("occurred_at") or "", reverse=True)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("Timeline fetch failed: %s", e)
        return jsonify({"error": str(e)}), 500
