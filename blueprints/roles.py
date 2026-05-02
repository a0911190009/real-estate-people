# -*- coding: utf-8 -*-
"""
角色（Role）Blueprint
路由：/api/people/<pid>/roles/...

每個 person 可掛多個角色（buyer / seller / introducer / landlord / peer / friend / relative / owner_friend），
每個角色一個獨立子文件，存「該角色才有的欄位」。

Firestore 結構：
  people/{pid}/roles/{role_type}    role_type 當作 doc_id（每種角色每人最多一個）

特殊規則：
  - 賣方（seller） identity=agent 必須有 agent_authorization_file，否則 has_blocking_warning=true
    （後端僅標記，UI 顯示紅色警示；不阻擋儲存，避免使用者卡住）
  - 移除角色 = archived_at 設值，不真刪除（保留歷史 = 來時路）
"""

import os
import uuid
import logging

from flask import Blueprint, request, jsonify

from auth import require_user
from firestore_client import get_db, server_timestamp
from gcs_helpers import gcs_upload_image, gcs_delete_blob


bp = Blueprint("roles", __name__)


# ─────────────── 常數 ───────────────

VALID_ROLE_TYPES = {
    "buyer", "seller", "introducer", "landlord",
    "peer", "friend", "relative", "owner_friend",
}

BUYER_STATUSES = {"洽談中", "持續看物件", "暫無需求", "保持連繫", "成交", "流失"}
SELLER_STATUSES = {"培養中", "已報價", "已簽委託", "已成交", "放棄"}
URGENCY_LEVELS = {"high", "medium", "low"}

PROPERTY_CATEGORIES = {"透天", "公寓", "農地", "建地", "店面", "別墅", "華廈", "套房", "其他"}
SELLER_IDENTITIES = {"sole_owner", "co_owner", "agent"}
DECORATION_STATUSES = {"毛胚", "裝潢", "自住", "租出"}
CURRENT_USES = {"self", "rent", "empty"}


# ─────────────── 輔助 ───────────────

def _str_or_none(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _num_or_none(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _bool(v):
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.lower() in ("true", "1", "yes", "on")
    return bool(v)


def _list_str(v):
    """確保是字串陣列。"""
    if not isinstance(v, list):
        return []
    return [str(x).strip() for x in v if str(x).strip()]


def _range_dict(v):
    """{ min?, max? } 規格化（坪數/預算等）。"""
    if not isinstance(v, dict):
        return {}
    out = {}
    if v.get("min") is not None:
        n = _num_or_none(v["min"])
        if n is not None:
            out["min"] = n
    if v.get("max") is not None:
        n = _num_or_none(v["max"])
        if n is not None:
            out["max"] = n
    return out


# ─────────────── 各角色 Validator ───────────────

def _validate_buyer(data):
    """買方角色資料規格化。"""
    status = _str_or_none(data.get("status"))
    if status and status not in BUYER_STATUSES:
        return None, f"買方 status 只能是 {BUYER_STATUSES}"

    urgency = _str_or_none(data.get("urgency"))
    if urgency and urgency not in URGENCY_LEVELS:
        return None, f"urgency 只能是 {URGENCY_LEVELS}"

    cat_pref = _list_str(data.get("category_pref", []))
    invalid_cats = [c for c in cat_pref if c not in PROPERTY_CATEGORIES]
    if invalid_cats:
        return None, f"category_pref 含無效類別：{invalid_cats}"

    payload = {
        "motivation": _str_or_none(data.get("motivation")),
        "family_composition": _str_or_none(data.get("family_composition")),
        "decision_maker": _str_or_none(data.get("decision_maker")),
        "urgency": urgency,
        "category_pref": cat_pref,
        "area_pref": _list_str(data.get("area_pref", [])),
        "area_avoid": _list_str(data.get("area_avoid", [])),
        "size_indoor": _range_dict(data.get("size_indoor", {})),
        "size_land": _range_dict(data.get("size_land", {})),
        "rooms": _num_or_none(data.get("rooms")),
        "bathrooms": _num_or_none(data.get("bathrooms")),
        "special_needs": _str_or_none(data.get("special_needs")),
        "budget_max": _num_or_none(data.get("budget_max")),
        "cash_available": _num_or_none(data.get("cash_available")),
        "loan_plan": _str_or_none(data.get("loan_plan")),
        "commute_route": _str_or_none(data.get("commute_route")),
        "school_district": _str_or_none(data.get("school_district")),
        "must_haves": _str_or_none(data.get("must_haves")),
        "status": status or "洽談中",
    }
    return payload, None


def _validate_seller(data):
    """賣方角色資料規格化。"""
    status = _str_or_none(data.get("status"))
    if status and status not in SELLER_STATUSES:
        return None, f"賣方 status 只能是 {SELLER_STATUSES}"

    identity = _str_or_none(data.get("identity"))
    if identity and identity not in SELLER_IDENTITIES:
        return None, f"identity 只能是 {SELLER_IDENTITIES}"

    urgency = _str_or_none(data.get("urgency"))
    if urgency and urgency not in URGENCY_LEVELS:
        return None, f"urgency 只能是 {URGENCY_LEVELS}"

    category = _str_or_none(data.get("category"))
    if category and category not in PROPERTY_CATEGORIES:
        return None, f"category 含無效類別：{category}"

    decoration = _str_or_none(data.get("decoration_status"))
    if decoration and decoration not in DECORATION_STATUSES:
        return None, f"decoration_status 只能是 {DECORATION_STATUSES}"

    current_use = _str_or_none(data.get("current_use"))
    if current_use and current_use not in CURRENT_USES:
        return None, f"current_use 只能是 {CURRENT_USES}"

    payload = {
        "property_address": _str_or_none(data.get("property_address")),
        "land_number": _str_or_none(data.get("land_number")),
        "category": category,
        "size_indoor": _num_or_none(data.get("size_indoor")),
        "size_land": _num_or_none(data.get("size_land")),
        "age": _num_or_none(data.get("age")),
        "decoration_status": decoration,
        "current_use": current_use,
        "has_tenant": _bool(data.get("has_tenant")),
        "tenant_lease_end": _str_or_none(data.get("tenant_lease_end")),
        "has_mortgage": _bool(data.get("has_mortgage")),
        "mortgage_balance": _num_or_none(data.get("mortgage_balance")),
        "identity": identity,
        "co_owners": _str_or_none(data.get("co_owners")),
        # agent_authorization_file 不在這裡設定，由 upload-auth 端點獨立寫入
        "motivation": _str_or_none(data.get("motivation")),
        "owner_price": _num_or_none(data.get("owner_price")),
        "bottom_price": _num_or_none(data.get("bottom_price")),
        "urgency": urgency,
        "showing_availability": _str_or_none(data.get("showing_availability")),
        "status": status or "培養中",
    }
    return payload, None


def _validate_landlord(data):
    payload = {
        "rental_property": _str_or_none(data.get("rental_property")),
        "rent_amount": _num_or_none(data.get("rent_amount")),
        "current_tenant": _str_or_none(data.get("current_tenant")),
        "note": _str_or_none(data.get("note")),
    }
    return payload, None


def _validate_peer(data):
    payload = {
        "position": _str_or_none(data.get("position")),
        "cooperation_note": _str_or_none(data.get("cooperation_note")),
    }
    return payload, None


def _validate_simple(data):
    """introducer / friend / relative / owner_friend：只存 note。"""
    return {"note": _str_or_none(data.get("note"))}, None


VALIDATORS = {
    "buyer": _validate_buyer,
    "seller": _validate_seller,
    "landlord": _validate_landlord,
    "peer": _validate_peer,
    "introducer": _validate_simple,
    "friend": _validate_simple,
    "relative": _validate_simple,
    "owner_friend": _validate_simple,
}


# ─────────────── 共用：警示計算（賣方代理人鎖） ───────────────

def _compute_seller_blocking(role_doc):
    """
    賣方角色：identity=agent 但無授權書 → 標記 has_blocking_warning。
    回傳 dict 補充欄位（has_blocking_warning, blocking_reason）。
    """
    identity = (role_doc or {}).get("identity")
    auth_file = (role_doc or {}).get("agent_authorization_file")
    if identity == "agent" and not auth_file:
        return {
            "has_blocking_warning": True,
            "blocking_reason": "代理人身份缺授權書，無法執行帶看 / 簽委託",
        }
    return {"has_blocking_warning": False, "blocking_reason": None}


def _doc_to_dict(doc):
    """role doc → dict（id 即 role_type，timestamp 轉字串）。"""
    d = doc.to_dict() or {}
    d["role_type"] = doc.id
    for key in ("created_at", "updated_at", "archived_at"):
        v = d.get(key)
        if v is not None and hasattr(v, "isoformat"):
            d[key] = v.isoformat()
    # 賣方額外計算 blocking 警示
    if doc.id == "seller":
        d.update(_compute_seller_blocking(d))
    return d


def _add_timeline(person_ref, email, type_, display_text, payload):
    """寫一條 timeline 事件。"""
    person_ref.collection("timeline").add({
        "type": type_,
        "display_text": display_text,
        "payload": payload,
        "occurred_at": server_timestamp(),
        "created_by": email,
    })


def _refresh_active_roles(person_ref):
    """
    重新計算 active_roles + has_completed_deal（以 archived_at=null 的 role doc 為準）。
    has_completed_deal：任何 active role 的 status 為 '成交' 或 '已成交' → True
    用於前端「已成交」tab 篩選。
    """
    roles = list(person_ref.collection("roles").stream())
    active = []
    has_deal = False
    for r in roles:
        rd = r.to_dict() or {}
        if rd.get("archived_at"):
            continue
        active.append(r.id)
        if rd.get("status") in ("成交", "已成交"):
            has_deal = True
    person_ref.update({
        "active_roles": active,
        "has_completed_deal": has_deal,
        "updated_at": server_timestamp(),
    })


# ══════════════════════════════════════════
#  Routes
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/roles", methods=["GET"])
def list_roles(pid):
    """列出此人所有角色（含已封存）。Query ?include_archived=1 才帶封存的。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    include_archived = request.args.get("include_archived") == "1"
    try:
        person_ref = db.collection("people").document(pid)
        snap = person_ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        docs = list(person_ref.collection("roles").stream())
        items = []
        for d in docs:
            data = _doc_to_dict(d)
            if not include_archived and data.get("archived_at"):
                continue
            items.append(data)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("Roles list failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/roles/<role_type>", methods=["GET"])
def get_role(pid, role_type):
    if role_type not in VALID_ROLE_TYPES:
        return jsonify({"error": f"role_type 只能是 {VALID_ROLE_TYPES}"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        rsnap = person_ref.collection("roles").document(role_type).get()
        if not rsnap.exists:
            return jsonify({"error": "此人未掛此角色"}), 404
        return jsonify(_doc_to_dict(rsnap))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/roles/<role_type>", methods=["POST"])
def add_role(pid, role_type):
    """加角色（若已存在且 archived → 視為「重新啟用」並更新資料）。"""
    if role_type not in VALID_ROLE_TYPES:
        return jsonify({"error": f"role_type 只能是 {VALID_ROLE_TYPES}"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    validator = VALIDATORS[role_type]
    role_payload, msg = validator(data)
    if msg:
        return jsonify({"error": msg}), 400

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        role_ref = person_ref.collection("roles").document(role_type)
        existing = role_ref.get()

        was_archived = bool((existing.to_dict() or {}).get("archived_at")) if existing.exists else False

        full = dict(role_payload)
        full["updated_at"] = server_timestamp()
        full["archived_at"] = None  # 重新啟用時清掉

        if not existing.exists:
            full["created_at"] = server_timestamp()
            full["created_by"] = email
            display = f"加角色：{role_type}"
            event_type = "role_added"
        elif was_archived:
            display = f"重新啟用角色：{role_type}"
            event_type = "role_reactivated"
        else:
            display = f"更新角色：{role_type}"
            event_type = "role_updated"

        role_ref.set(full, merge=True)
        _refresh_active_roles(person_ref)
        _add_timeline(person_ref, email, event_type, display, {"role_type": role_type})

        return jsonify(_doc_to_dict(role_ref.get())), 201 if not existing.exists else 200
    except Exception as e:
        logging.warning("Role add failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/roles/<role_type>", methods=["PUT"])
def update_role(pid, role_type):
    """更新角色資料（status 變化會寫 timeline）。"""
    if role_type not in VALID_ROLE_TYPES:
        return jsonify({"error": f"role_type 只能是 {VALID_ROLE_TYPES}"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    validator = VALIDATORS[role_type]
    role_payload, msg = validator(data)
    if msg:
        return jsonify({"error": msg}), 400

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        role_ref = person_ref.collection("roles").document(role_type)
        existing = role_ref.get()
        if not existing.exists:
            return jsonify({"error": "此人未掛此角色，請改用 POST"}), 404

        old = existing.to_dict() or {}
        new_status = role_payload.get("status")
        old_status = old.get("status")

        role_payload["updated_at"] = server_timestamp()
        role_ref.set(role_payload, merge=True)

        # 狀態變更會影響 has_completed_deal，需重算
        _refresh_active_roles(person_ref)

        if old_status and new_status and old_status != new_status:
            _add_timeline(
                person_ref, email, "status_changed",
                f"{role_type} 狀態：{old_status} → {new_status}",
                {"role_type": role_type, "from": old_status, "to": new_status},
            )

        return jsonify(_doc_to_dict(role_ref.get()))
    except Exception as e:
        logging.warning("Role update failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/roles/<role_type>", methods=["DELETE"])
def archive_role(pid, role_type):
    """封存角色（不真刪除，標 archived_at）。對應「買者恆買」原則。"""
    if role_type not in VALID_ROLE_TYPES:
        return jsonify({"error": f"role_type 只能是 {VALID_ROLE_TYPES}"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        role_ref = person_ref.collection("roles").document(role_type)
        if not role_ref.get().exists:
            return jsonify({"error": "此人未掛此角色"}), 404
        role_ref.update({"archived_at": server_timestamp(), "updated_at": server_timestamp()})
        _refresh_active_roles(person_ref)
        _add_timeline(person_ref, email, "role_archived", f"封存角色：{role_type}", {"role_type": role_type})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  賣方代理人授權書（特殊端點）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/roles/seller/auth-file", methods=["POST"])
def upload_auth_file(pid):
    """
    上傳賣方代理人授權書到 GCS，寫入 seller role 的 agent_authorization_file 欄位。
    Form data: file=<binary>
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    f = request.files.get("file")
    if not f:
        return jsonify({"error": "未提供檔案"}), 400

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        role_ref = person_ref.collection("roles").document("seller")
        if not role_ref.get().exists:
            return jsonify({"error": "此人尚未掛賣方角色"}), 404

        ext = ""
        if "." in f.filename:
            ext = f.filename.rsplit(".", 1)[1].lower()
        gcs_path = f"people-files/{email}/{pid}/seller-auth/{uuid.uuid4().hex}.{ext}" if ext else f"people-files/{email}/{pid}/seller-auth/{uuid.uuid4().hex}"
        content_type = f.mimetype or "application/octet-stream"
        result = gcs_upload_image(gcs_path, f.read(), content_type=content_type)
        if not result:
            return jsonify({"error": "GCS 上傳失敗"}), 500

        # 若已有舊授權書，先刪除
        old_doc = role_ref.get().to_dict() or {}
        old_auth = old_doc.get("agent_authorization_file") or {}
        if old_auth.get("gcs_path"):
            gcs_delete_blob(old_auth["gcs_path"])

        auth_meta = {
            "gcs_path": gcs_path,
            "filename": f.filename,
            "mime_type": content_type,
            "uploaded_at": server_timestamp(),
        }
        role_ref.update({
            "agent_authorization_file": auth_meta,
            "updated_at": server_timestamp(),
        })
        person_ref.update({"updated_at": server_timestamp()})

        _add_timeline(
            person_ref, email, "auth_file_uploaded",
            f"上傳賣方代理人授權書：{f.filename}",
            {"role_type": "seller", "filename": f.filename},
        )

        return jsonify({"ok": True, "agent_authorization_file": {**auth_meta, "uploaded_at": "now"}}), 201
    except Exception as e:
        logging.warning("Auth file upload failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/roles/seller/auth-file", methods=["DELETE"])
def delete_auth_file(pid):
    """移除賣方代理人授權書。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        role_ref = person_ref.collection("roles").document("seller")
        if not role_ref.get().exists:
            return jsonify({"error": "此人尚未掛賣方角色"}), 404
        old_doc = role_ref.get().to_dict() or {}
        old_auth = old_doc.get("agent_authorization_file") or {}
        if old_auth.get("gcs_path"):
            gcs_delete_blob(old_auth["gcs_path"])
        role_ref.update({"agent_authorization_file": None, "updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  介紹人成就感視覺化（即時計算）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/roles/introducer/stats", methods=["GET"])
def introducer_stats(pid):
    """
    計算此介紹人介紹過幾人 / 成交幾人。
    依據：people 主檔的 source.referrer_person_id == pid。
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        person_ref = db.collection("people").document(pid)
        psnap = person_ref.get()
        if not psnap.exists or (psnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        # 找出所有 source.referrer_person_id == pid 的人（且為自己創建）
        introduced = list(
            db.collection("people")
            .where("created_by", "==", email)
            .where("source.referrer_person_id", "==", pid)
            .stream()
        )

        introduced_list = []
        deal_count = 0
        for doc in introduced:
            d = doc.to_dict() or {}
            if d.get("deleted_at"):
                continue
            # 判斷是否成交：buyer.status == 成交 或 seller.status == 已成交
            is_deal = False
            for role_type in ("buyer", "seller"):
                rsnap = doc.reference.collection("roles").document(role_type).get()
                if rsnap.exists:
                    rd = rsnap.to_dict() or {}
                    s = rd.get("status")
                    if s in ("成交", "已成交"):
                        is_deal = True
                        break
            if is_deal:
                deal_count += 1
            introduced_list.append({
                "id": doc.id,
                "name": d.get("name"),
                "active_roles": d.get("active_roles", []),
                "is_deal": is_deal,
            })

        return jsonify({
            "introduced_count": len(introduced_list),
            "deal_count": deal_count,
            "deal_rate": (deal_count / len(introduced_list)) if introduced_list else 0,
            "introduced": introduced_list,
        })
    except Exception as e:
        logging.warning("Introducer stats failed: %s", e)
        return jsonify({"error": str(e)}), 500
