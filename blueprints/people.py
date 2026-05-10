# -*- coding: utf-8 -*-
"""
人脈主檔 CRUD Blueprint
路由：/api/people, /api/people/<id>, /api/people/<id>/avatar, /api/people/<id>/files

Firestore 集合：
  people/{person_id}                    主檔
  people/{person_id}/files/{file_id}    附件（metadata；實體存 GCS）

漸進式連結欄位：
  legacy_buyer_id   手動連結既有 buyers/ doc
  legacy_seller_id  手動連結既有 seller_prospects/ doc
"""

import os
import uuid
import logging
from datetime import datetime, timezone, timedelta

from flask import Blueprint, request, jsonify

from auth import require_user, verify_service_key
from firestore_client import get_db, server_timestamp
from gcs_helpers import gcs_upload_image, gcs_delete_blob, gcs_serve_blob
from audio_helper import transcribe_audio, transcribe_image_conversation


bp = Blueprint("people", __name__)

# ─────────────── 常數 ───────────────

VALID_BUCKETS = {"primary", "normal", "watching", "frozen", "closed", "blacklist"}
VALID_GROUP_TYPES = {"permanent", "temporary"}
VALID_CONTACT_TYPES = {"mobile", "home", "work", "line_id", "wechat", "email", "other"}
VALID_ADDRESS_TYPES = {"home", "office", "other"}
VALID_GENDERS = {"M", "F", "other"}
VALID_SOURCE_CHANNELS = {"referral", "ad", "walk_in", "phone_in", "peer", "company", "other"}
VALID_RELATION_TYPES = {
    "spouse", "parent", "child", "sibling",
    "friend", "partner", "introduced_by", "introduced", "other"
}

ZODIAC_RANGES = [
    ((1, 20),  "摩羯"), ((2, 19),  "水瓶"), ((3, 21),  "雙魚"),
    ((4, 20),  "牡羊"), ((5, 21),  "金牛"), ((6, 22),  "雙子"),
    ((7, 23),  "巨蟹"), ((8, 23),  "獅子"), ((9, 23),  "處女"),
    ((10, 24), "天秤"), ((11, 23), "天蠍"), ((12, 22), "射手"),
    ((12, 31), "摩羯"),  # 12/22 之後也是摩羯
]


# ─────────────── 工具函式 ───────────────

def _zodiac_from_birthday(birthday):
    """從 YYYY-MM-DD 算星座。失敗回 None。"""
    if not birthday:
        return None
    try:
        dt = datetime.strptime(birthday, "%Y-%m-%d")
        for (m, d), name in ZODIAC_RANGES:
            if (dt.month, dt.day) <= (m, d):
                return name
        return "摩羯"
    except Exception:
        return None


def _normalize_contacts(raw):
    """清理 contacts 陣列：濾掉空值，驗證 type。"""
    if not isinstance(raw, list):
        return []
    out = []
    for c in raw:
        if not isinstance(c, dict):
            continue
        ctype = str(c.get("type", "")).strip()
        cval = str(c.get("value", "")).strip()
        if not cval:
            continue
        if ctype not in VALID_CONTACT_TYPES:
            ctype = "other"
        out.append({
            "type": ctype,
            "value": cval,
            "label": str(c.get("label", "") or "").strip() or None,
        })
    return out


def _normalize_addresses(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for a in raw:
        if not isinstance(a, dict):
            continue
        atype = str(a.get("type", "")).strip()
        aval = str(a.get("value", "")).strip()
        if not aval:
            continue
        if atype not in VALID_ADDRESS_TYPES:
            atype = "other"
        item = {"type": atype, "value": aval}
        # lat/lng 可選
        if a.get("lat") is not None and a.get("lng") is not None:
            try:
                item["lat"] = float(a["lat"])
                item["lng"] = float(a["lng"])
            except (TypeError, ValueError):
                pass
        out.append(item)
    return out


def _normalize_source(raw):
    """清理 source 物件。"""
    if not isinstance(raw, dict):
        return {"channel": "other", "referrer_person_id": None, "note": ""}
    ch = str(raw.get("channel", "other")).strip()
    if ch not in VALID_SOURCE_CHANNELS:
        ch = "other"
    return {
        "channel": ch,
        "referrer_person_id": raw.get("referrer_person_id") or None,
        "note": str(raw.get("note", "") or "").strip(),
    }


def _build_person_payload(data, email, is_create=True):
    """
    從前端送來的 dict 組成 Firestore 寫入用 dict。
    is_create=True 才會塞 created_by / created_at / 預設值。
    """
    name = str(data.get("name", "")).strip()
    if not name:
        return None, "姓名必填"

    bucket = str(data.get("bucket", "normal")).strip()
    if bucket not in VALID_BUCKETS:
        bucket = "normal"

    gender = data.get("gender")
    if gender is not None:
        gender = str(gender).strip()
        if gender not in VALID_GENDERS:
            gender = None

    birthday = str(data.get("birthday", "") or "").strip() or None

    # 群組欄位（is_group=True 時有效）
    is_group = bool(data.get("is_group", False))
    group_type = str(data.get("group_type", "") or "").strip() or None
    if is_group and group_type not in VALID_GROUP_TYPES:
        group_type = "temporary"
    members_raw = data.get("members", []) or []
    members = [str(m).strip() for m in members_raw if str(m).strip()] if isinstance(members_raw, list) else []

    # card_color：6 碼 hex（含 #），空字串視為無色
    card_color_raw = str(data.get("card_color", "") or "").strip()
    card_color = card_color_raw if card_color_raw.startswith("#") and 4 <= len(card_color_raw) <= 9 else None

    payload = {
        "name": name,
        "display_name": str(data.get("display_name", "") or "").strip() or None,
        "birthday": birthday,
        "zodiac": _zodiac_from_birthday(birthday),
        "gender": gender,
        "company": str(data.get("company", "") or "").strip() or None,
        "contacts": _normalize_contacts(data.get("contacts", [])),
        "addresses": _normalize_addresses(data.get("addresses", [])),
        "bucket": bucket,
        "warning": str(data.get("warning", "") or "").strip() or None,
        "source": _normalize_source(data.get("source", {})),
        "is_group": is_group,
        "group_type": group_type if is_group else None,
        "members": members if is_group else [],
        "card_color": card_color,
        "note": str(data.get("note", "") or "").strip() or None,
        "phone": str(data.get("phone", "") or "").strip() or None,
        "updated_at": server_timestamp(),
    }

    if is_create:
        payload["avatar_b64"] = None
        payload["active_roles"] = []  # 由 roles blueprint 維護
        payload["has_completed_deal"] = False  # 由 roles blueprint 自動維護
        payload["relations"] = []     # 由 relations blueprint 維護
        payload["legacy_buyer_id"] = None
        payload["legacy_seller_id"] = None
        payload["last_contact_at"] = None
        payload["sort_order"] = None  # 拖曳排序時設值；null 則 fallback 到 last_contact_at 排序
        payload["deleted_at"] = None
        payload["created_by"] = email
        payload["created_at"] = server_timestamp()

    return payload, None


def _doc_to_dict(doc):
    """Firestore doc → dict（含 id，並把 timestamp 轉 ISO 字串）。"""
    d = doc.to_dict() or {}
    d["id"] = doc.id
    # timestamp 序列化
    for key in ("created_at", "updated_at", "last_contact_at", "deleted_at"):
        v = d.get(key)
        if v is not None and hasattr(v, "isoformat"):
            d[key] = v.isoformat()
    return d


def _now_utc():
    return datetime.now(timezone.utc)


# ══════════════════════════════════════════
#  主檔 CRUD
# ══════════════════════════════════════════

@bp.route("/api/people", methods=["GET"])
def list_people():
    """
    人脈列表。
    Query params:
      bucket    篩選收納分類（可多選，逗號分隔）
      role      篩選角色標籤（單選；對應 active_roles 陣列）
      search    搜尋姓名 / 電話（簡易：客戶端 filter）
      limit     回傳上限（預設 200）
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"items": [], "error": "Firestore 未初始化"}), 503

    bucket_filter = [b for b in (request.args.get("bucket") or "").split(",") if b.strip()]
    role_filter = (request.args.get("role") or "").strip()
    search = (request.args.get("search") or "").strip().lower()
    try:
        limit = min(int(request.args.get("limit", 200)), 500)
    except ValueError:
        limit = 200

    try:
        q = db.collection("people").where("created_by", "==", email)
        if role_filter:
            q = q.where("active_roles", "array_contains", role_filter)
        # bucket 多選 → in 子句（最多 10 個）
        if bucket_filter and len(bucket_filter) <= 10:
            q = q.where("bucket", "in", bucket_filter)
        docs = list(q.limit(limit).stream())
    except Exception as e:
        logging.warning("People list query failed: %s", e)
        return jsonify({"items": [], "error": str(e)}), 500

    items = []
    for doc in docs:
        d = _doc_to_dict(doc)
        # 軟刪除過濾
        if d.get("deleted_at"):
            continue
        # 客戶端 search filter（姓名 / 電話）
        if search:
            hay = (d.get("name", "") + " " + (d.get("display_name", "") or "")).lower()
            for c in d.get("contacts", []) or []:
                hay += " " + (c.get("value", "") or "")
            if search not in hay.lower():
                continue
        items.append(d)

    # 按 last_contact_at 降冪排序（None 排最後）
    items.sort(
        key=lambda x: (x.get("last_contact_at") or "0000"),
        reverse=True,
    )

    return jsonify({"items": items, "count": len(items)})


@bp.route("/api/people", methods=["POST"])
def create_person():
    """新增人脈主檔。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    payload, msg = _build_person_payload(data, email, is_create=True)
    if payload is None:
        return jsonify({"error": msg}), 400

    try:
        ref = db.collection("people").document()
        ref.set(payload)
        # 寫入 timeline：person_created
        ref.collection("timeline").add({
            "type": "person_created",
            "display_text": f"建立人脈：{payload['name']}",
            "payload": {"name": payload["name"]},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        doc = ref.get()
        return jsonify(_doc_to_dict(doc)), 201
    except Exception as e:
        logging.warning("People create failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/create-for-agent", methods=["POST"])
def create_person_for_agent():
    """供 Portal AI Agent 呼叫：用 X-Service-Key 驗證 + body.email 指定使用者。
    body: {email, name, phone, note, role}
      role: 可選，buyer/seller/introducer/peer/landlord/friend/relative
    """
    if not verify_service_key():
        return jsonify({"ok": False, "error": "未授權"}), 401
    db = get_db()
    if db is None:
        return jsonify({"ok": False, "error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip()
    if not email:
        return jsonify({"ok": False, "error": "email 必填"}), 400

    payload, msg = _build_person_payload(data, email, is_create=True)
    if payload is None:
        return jsonify({"ok": False, "error": msg}), 400

    try:
        ref = db.collection("people").document()
        ref.set(payload)
        ref.collection("timeline").add({
            "type": "person_created",
            "display_text": f"建立人脈：{payload['name']}（由 AI 助理新增）",
            "payload": {"name": payload["name"], "via": "agent"},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        # 若有指定角色，順便建立 active role
        role = str(data.get("role", "") or "").strip()
        VALID_ROLES = {"buyer", "seller", "introducer", "peer", "landlord", "friend", "relative", "owner_friend"}
        if role in VALID_ROLES:
            ref.collection("roles").document(role).set({
                "type": role,
                "status": "active",
                "created_at": server_timestamp(),
                "updated_at": server_timestamp(),
            })
            ref.update({"active_roles": [role]})
        return jsonify({"ok": True, "id": ref.id, "name": payload["name"], "role": role or None}), 201
    except Exception as e:
        logging.warning("Agent create person failed: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/people/<pid>", methods=["GET"])
def get_person(pid):
    """取得單筆主檔（不含 roles 子集合，roles 由 roles blueprint 提供）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        doc = db.collection("people").document(pid).get()
        if not doc.exists:
            return jsonify({"error": "找不到此人"}), 404
        d = _doc_to_dict(doc)
        if d.get("created_by") != email or d.get("deleted_at"):
            return jsonify({"error": "找不到此人"}), 404
        return jsonify(d)
    except Exception as e:
        logging.warning("People get failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<from_id>/merge-to/<to_id>", methods=["POST"])
def merge_person(from_id, to_id):
    """把 from_id 的所有資料合併到 to_id，並把 from 軟刪除（deleted_at）。

    合併規則：
    - 主檔欄位：B 為主，B 空才用 A
    - active_roles: union
    - 備註：B + 分隔線 + A
    - 子集合（contacts / files / properties / timeline / roles）：A 全部複製到 B
    - 引用更新：其他 person 的 relations / members 中指到 A 的，改指 B
    - 寫一筆 timeline 到 B：「合併自 XXX」
    - A 設 deleted_at（軟刪除，可從垃圾桶救回）
    """
    if from_id == to_id:
        return jsonify({"error": "不能跟自己合併"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        from_ref = db.collection("people").document(from_id)
        to_ref = db.collection("people").document(to_id)
        from_snap = from_ref.get()
        to_snap = to_ref.get()
        if not from_snap.exists or not to_snap.exists:
            return jsonify({"error": "找不到其中一筆人脈"}), 404
        from_doc = from_snap.to_dict() or {}
        to_doc = to_snap.to_dict() or {}
        if from_doc.get("created_by") != email or to_doc.get("created_by") != email:
            return jsonify({"error": "權限不足"}), 403

        # 1. 合併主檔欄位（B 為主，B 空才用 A 的）
        patch = {}
        for k in ("phone", "note", "card_color", "avatar_b64", "company", "display_name", "birthday", "zodiac", "gender", "warning"):
            if not to_doc.get(k) and from_doc.get(k):
                patch[k] = from_doc[k]
        # 備註特別：兩邊都有 → 串起來
        if to_doc.get("note") and from_doc.get("note") and to_doc["note"] != from_doc["note"]:
            patch["note"] = f"{to_doc['note']}\n\n--- 合併自「{from_doc.get('name','')}」---\n{from_doc['note']}"
        # contacts / addresses 陣列：合併（去重）
        def _merge_list(a, b, key=None):
            out = list(a or [])
            seen = {(x.get(key) if key else x) for x in out} if a else set()
            for x in (b or []):
                k = x.get(key) if key else x
                if k not in seen:
                    out.append(x)
                    seen.add(k)
            return out
        merged_contacts = _merge_list(to_doc.get("contacts"), from_doc.get("contacts"), key="value")
        if merged_contacts != (to_doc.get("contacts") or []):
            patch["contacts"] = merged_contacts
        merged_addresses = _merge_list(to_doc.get("addresses"), from_doc.get("addresses"), key="value")
        if merged_addresses != (to_doc.get("addresses") or []):
            patch["addresses"] = merged_addresses
        # active_roles: union
        union_roles = list(set((to_doc.get("active_roles") or []) + (from_doc.get("active_roles") or [])))
        if set(union_roles) != set(to_doc.get("active_roles") or []):
            patch["active_roles"] = union_roles
        # legacy id：B 沒就用 A 的
        for k in ("legacy_buyer_id", "legacy_seller_id"):
            if not to_doc.get(k) and from_doc.get(k):
                patch[k] = from_doc[k]
        # has_completed_deal: OR
        if from_doc.get("has_completed_deal"):
            patch["has_completed_deal"] = True

        if patch:
            patch["updated_at"] = server_timestamp()
            to_ref.update(patch)

        # 2. 子集合搬遷（A → B）
        moved = {"contacts": 0, "files": 0, "properties": 0, "timeline": 0, "roles": 0}
        for sub in ("contacts", "files", "properties", "timeline"):
            for d in from_ref.collection(sub).stream():
                data = d.to_dict() or {}
                # 用同 doc id 寫到 B（避免重新命名 / 同 id 不會衝突因為兩邊獨立 collection）
                to_ref.collection(sub).document(d.id).set(data, merge=True)
                moved[sub] += 1
        # roles：B 已有的角色保留 B 的；A 才有的接過來
        existing_role_ids = {r.id for r in to_ref.collection("roles").stream()}
        for d in from_ref.collection("roles").stream():
            if d.id in existing_role_ids:
                continue  # B 已有此角色
            data = d.to_dict() or {}
            to_ref.collection("roles").document(d.id).set(data)
            moved["roles"] += 1

        # 3. 更新其他 person 文件中指到 from 的引用
        # relations: 其他人的 relations 陣列裡 person_id == from_id → 改成 to_id
        # members: 其他人的 members 陣列裡含 from_id → 改成 to_id
        # 因為陣列是字串/物件，要全量讀+寫回
        all_people = db.collection("people").where("created_by", "==", email).stream()
        for p in all_people:
            if p.id in (from_id, to_id):
                continue
            pd = p.to_dict() or {}
            updates = {}
            # relations
            rels = pd.get("relations") or []
            new_rels = []
            rels_changed = False
            for r in rels:
                if isinstance(r, dict) and r.get("person_id") == from_id:
                    r2 = dict(r)
                    r2["person_id"] = to_id
                    new_rels.append(r2)
                    rels_changed = True
                else:
                    new_rels.append(r)
            if rels_changed:
                updates["relations"] = new_rels
            # members（群組）
            members = pd.get("members") or []
            if from_id in members:
                new_members = [(to_id if m == from_id else m) for m in members]
                # 去重（萬一群組已有 to_id）
                seen = set()
                deduped = []
                for m in new_members:
                    if m not in seen:
                        seen.add(m)
                        deduped.append(m)
                updates["members"] = deduped
            if updates:
                p.reference.update(updates)

        # 4. timeline 寫一筆「合併自 XXX」到 B
        to_ref.collection("timeline").add({
            "type": "merged_from",
            "display_text": f"合併自「{from_doc.get('name', '')}」",
            "payload": {
                "from_id": from_id,
                "from_name": from_doc.get("name"),
                "moved": moved,
            },
            "occurred_at": server_timestamp(),
            "created_by": email,
        })

        # 5. 軟刪除 from
        from_ref.update({
            "deleted_at": server_timestamp(),
            "merged_into": to_id,
            "updated_at": server_timestamp(),
        })

        return jsonify({
            "ok": True,
            "moved": moved,
            "to_id": to_id,
            "from_id": from_id,
        })
    except Exception as e:
        logging.warning("Merge failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/find", methods=["GET"])
def find_person_by_name():
    """以姓名（+電話為輔助）搜尋既有人脈。
    Query: name=...（必填）、phone=...（選填，協助同名分辨）
    回傳：{"items": [{id, name, phone, active_roles, ...}]}
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    name = (request.args.get("name") or "").strip()
    if not name:
        return jsonify({"items": []})
    phone = (request.args.get("phone") or "").strip()
    try:
        # Firestore 中文姓名可以用 == 精準比對
        q = db.collection("people").where("created_by", "==", email).where("name", "==", name)
        items = []
        for d in q.stream():
            data = d.to_dict() or {}
            if data.get("is_group") or data.get("deleted_at"):
                continue
            data["id"] = d.id
            items.append(data)
        # 若有電話，把吻合的排前
        if phone:
            import re
            np = re.sub(r"[\s\-\(\)]", "", phone)
            def _score(p):
                phones = [p.get("phone")] + [c.get("value") for c in (p.get("contacts") or []) if c.get("value")]
                for ph in phones:
                    if not ph: continue
                    if re.sub(r"[\s\-\(\)]", "", str(ph)) == np:
                        return 0
                return 1
            items.sort(key=_score)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("find_person_by_name failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>", methods=["PATCH"])
def patch_person(pid):
    """部分更新主檔欄位（白名單），不需重新驗證整份 payload。
    可改：card_color / note / phone / warning / bucket
    """
    PATCH_FIELDS = {"card_color", "note", "phone", "warning", "bucket"}
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    update_data = {}
    for k, v in data.items():
        if k not in PATCH_FIELDS:
            continue
        if k == "card_color":
            v = str(v or "").strip()
            update_data[k] = v if v.startswith("#") and 4 <= len(v) <= 9 else None
        elif k == "bucket":
            v = str(v or "").strip()
            update_data[k] = v if v in VALID_BUCKETS else "normal"
        else:
            update_data[k] = str(v or "").strip() or None

    if not update_data:
        return jsonify({"error": "沒有可更新的欄位"}), 400

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        update_data["updated_at"] = server_timestamp()
        ref.update(update_data)
        return jsonify(_doc_to_dict(ref.get()))
    except Exception as e:
        logging.warning("Patch person failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>", methods=["PUT"])
def update_person(pid):
    """更新主檔（不影響 roles 子集合）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到此人"}), 404
        existing = snap.to_dict() or {}
        if existing.get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        payload, msg = _build_person_payload(data, email, is_create=False)
        if payload is None:
            return jsonify({"error": msg}), 400

        # 偵測 bucket 變更 → 寫 timeline
        old_bucket = existing.get("bucket")
        new_bucket = payload.get("bucket")
        warning_changed = (existing.get("warning") or None) != (payload.get("warning") or None)

        ref.update(payload)

        if old_bucket != new_bucket:
            ref.collection("timeline").add({
                "type": "bucket_changed",
                "display_text": f"收納分類：{old_bucket} → {new_bucket}",
                "payload": {"from": old_bucket, "to": new_bucket},
                "occurred_at": server_timestamp(),
                "created_by": email,
            })
        if warning_changed and payload.get("warning"):
            ref.collection("timeline").add({
                "type": "warning_set",
                "display_text": f"警示語：{payload['warning']}",
                "payload": {"warning": payload["warning"]},
                "occurred_at": server_timestamp(),
                "created_by": email,
            })

        return jsonify(_doc_to_dict(ref.get()))
    except Exception as e:
        logging.warning("People update failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/trash", methods=["GET"])
def list_trash():
    """已軟刪除的人脈（垃圾桶）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"items": [], "error": "Firestore 未初始化"}), 503
    try:
        docs = list(db.collection("people").where("created_by", "==", email).stream())
        items = []
        for doc in docs:
            d = _doc_to_dict(doc)
            if d.get("deleted_at"):
                items.append(d)
        items.sort(key=lambda x: x.get("deleted_at") or "", reverse=True)
        return jsonify({"items": items, "count": len(items)})
    except Exception as e:
        return jsonify({"items": [], "error": str(e)}), 500


@bp.route("/api/people/<pid>/restore", methods=["POST"])
def restore_person(pid):
    """還原（清除 deleted_at）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        ref.update({
            "deleted_at": None,
            "updated_at": server_timestamp(),
        })
        ref.collection("timeline").add({
            "type": "person_restored",
            "display_text": "從垃圾桶還原",
            "payload": {},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/purge", methods=["DELETE"])
def purge_person(pid):
    """
    永久刪除：實刪 person + 所有子集合 + GCS 檔案。
    僅能對已軟刪除（deleted_at 已設）的執行，避免誤刪。
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到此人"}), 404
        d = snap.to_dict() or {}
        if d.get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        if not d.get("deleted_at"):
            return jsonify({"error": "請先軟刪除（從垃圾桶才能永久刪除）"}), 400

        # 刪所有 GCS 檔（files 子集合 + avatar 用 base64 不需處理）
        files = list(ref.collection("files").stream())
        for f in files:
            fdata = f.to_dict() or {}
            if fdata.get("gcs_path"):
                gcs_delete_blob(fdata["gcs_path"])

        # 刪所有子集合
        for subname in ("files", "contacts", "roles", "timeline"):
            for sub in ref.collection(subname).stream():
                sub.reference.delete()

        # 刪自己
        ref.delete()
        return jsonify({"ok": True})
    except Exception as e:
        logging.warning("Purge failed: %s", e)
        return jsonify({"error": str(e)}), 500


def _snapshot_current_orders(db, email):
    """讀取此用戶所有 people 文件的 sort_order，回傳 {pid: order}（已軟刪略過）"""
    out = {}
    for d in db.collection("people").where("created_by", "==", email).stream():
        data = d.to_dict() or {}
        if data.get("deleted_at"):
            continue
        if data.get("sort_order") is not None:
            out[d.id] = float(data["sort_order"])
    return out


@bp.route("/api/people/sort-arrangements", methods=["GET"])
def list_sort_arrangements():
    """列出此使用者所有命名整理。存放在 user_settings/{email}.sort_arrangements 陣列。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        snap = db.collection("user_settings").document(email).get()
        items = (snap.to_dict() or {}).get("sort_arrangements", []) if snap.exists else []
        # 排序：created_at desc（新的在前）
        items_clean = []
        for it in items:
            it2 = dict(it)
            for k in ("created_at", "updated_at"):
                v = it2.get(k)
                if hasattr(v, "isoformat"):
                    try: it2[k] = v.isoformat()
                    except Exception: pass
            items_clean.append(it2)
        items_clean.sort(key=lambda x: x.get("created_at") or "", reverse=True)
        return jsonify({"items": items_clean})
    except Exception as e:
        logging.warning("list_sort_arrangements failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/sort-arrangements", methods=["POST"])
def create_sort_arrangement():
    """命名儲存目前順序：拍照 sort_order → 存進 user_settings 陣列。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "") or "").strip()
    if not name:
        return jsonify({"error": "請提供 name"}), 400

    try:
        order_map = _snapshot_current_orders(db, email)
        if not order_map:
            return jsonify({"error": "目前沒有拖曳順序可儲存。請先拖曳卡片排個順序再來。"}), 400

        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
        new_item = {
            "id": uuid.uuid4().hex,
            "name": name,
            "order_map": order_map,
            "created_at": now_iso,
            "updated_at": now_iso,
        }
        # 用 ArrayUnion 加進陣列
        ref = db.collection("user_settings").document(email)
        snap = ref.get()
        if snap.exists:
            existing = (snap.to_dict() or {}).get("sort_arrangements", []) or []
            existing.append(new_item)
            ref.update({"sort_arrangements": existing})
        else:
            ref.set({"sort_arrangements": [new_item]})
        return jsonify(new_item), 201
    except Exception as e:
        logging.warning("create_sort_arrangement failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/sort-arrangements/<aid>", methods=["PATCH"])
def rename_sort_arrangement(aid):
    """重命名某個整理。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "") or "").strip()
    if not name:
        return jsonify({"error": "請提供 name"}), 400

    try:
        from datetime import datetime, timezone
        ref = db.collection("user_settings").document(email)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到"}), 404
        items = (snap.to_dict() or {}).get("sort_arrangements", []) or []
        found = False
        for it in items:
            if it.get("id") == aid:
                it["name"] = name
                it["updated_at"] = datetime.now(timezone.utc).isoformat()
                found = True
                break
        if not found:
            return jsonify({"error": "找不到此整理"}), 404
        ref.update({"sort_arrangements": items})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/sort-arrangements/<aid>", methods=["DELETE"])
def delete_sort_arrangement(aid):
    """刪除某個整理。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        ref = db.collection("user_settings").document(email)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"ok": True})
        items = (snap.to_dict() or {}).get("sort_arrangements", []) or []
        new_items = [it for it in items if it.get("id") != aid]
        ref.update({"sort_arrangements": new_items})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/sort-arrangements/<aid>/apply", methods=["POST"])
def apply_sort_arrangement(aid):
    """把命名整理的 order_map 寫回每筆 people.sort_order。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        ref = db.collection("user_settings").document(email)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到"}), 404
        items = (snap.to_dict() or {}).get("sort_arrangements", []) or []
        target = next((it for it in items if it.get("id") == aid), None)
        if not target:
            return jsonify({"error": "找不到此整理"}), 404
        order_map = target.get("order_map") or {}
        if not order_map:
            return jsonify({"error": "整理內無資料"}), 400

        # 批次寫回 sort_order（驗證每筆是該用戶的）
        batch = db.batch()
        count = 0
        for pid, so in order_map.items():
            pref = db.collection("people").document(pid)
            psnap = pref.get()
            if not psnap.exists:
                continue
            if (psnap.to_dict() or {}).get("created_by") != email:
                continue
            batch.update(pref, {
                "sort_order": float(so),
                "updated_at": server_timestamp(),
            })
            count += 1
        batch.commit()
        return jsonify({"ok": True, "applied": count, "name": target.get("name")})
    except Exception as e:
        logging.warning("apply_sort_arrangement failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/reorder", methods=["POST"])
def reorder_people():
    """
    批次更新多筆人的 sort_order（拖曳排序時呼叫）。
    Body: { "items": [{"id": "<pid>", "sort_order": 1}, ...] }
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    items = data.get("items", [])
    if not isinstance(items, list):
        return jsonify({"error": "items 必須是陣列"}), 400

    try:
        batch = db.batch()
        count = 0
        for item in items:
            pid = item.get("id")
            so = item.get("sort_order")
            if not pid or so is None:
                continue
            ref = db.collection("people").document(pid)
            snap = ref.get()
            if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
                continue
            batch.update(ref, {
                "sort_order": float(so),
                "updated_at": server_timestamp(),
            })
            count += 1
        batch.commit()
        return jsonify({"ok": True, "updated": count})
    except Exception as e:
        logging.warning("Reorder failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>", methods=["DELETE"])
def delete_person(pid):
    """軟刪除（標 deleted_at，不真刪除避免 timeline / roles 失聯）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到此人"}), 404
        if (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        ref.update({
            "deleted_at": server_timestamp(),
            "updated_at": server_timestamp(),
        })
        return jsonify({"ok": True})
    except Exception as e:
        logging.warning("People delete failed: %s", e)
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  頭像（base64，直接存 Firestore，沿用 buyer 模式）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/avatar", methods=["POST"])
def upload_avatar(pid):
    """
    上傳頭像。前端應先用 canvas 裁切到 160px 正方形 + JPEG 壓縮再送 base64。
    Body: { "avatar_b64": "data:image/jpeg;base64,..." }（也接受純 base64 字串）
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    b64 = data.get("avatar_b64", "")
    if not b64:
        return jsonify({"error": "avatar_b64 必填"}), 400
    # 簡易大小檢查：base64 長度 < 200KB（約 150KB JPEG）
    if len(b64) > 200_000:
        return jsonify({"error": "頭像過大，請先壓縮到 160px 正方形 JPEG"}), 400

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        ref.update({"avatar_b64": b64, "updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        logging.warning("Avatar upload failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/avatar", methods=["DELETE"])
def delete_avatar(pid):
    """移除頭像。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        ref.update({"avatar_b64": None, "updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  附件（GCS）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/files", methods=["POST"])
def upload_file(pid):
    """
    上傳附件到 GCS，metadata 寫到 people/{pid}/files/{file_id}。
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
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        ext = ""
        if "." in f.filename:
            ext = f.filename.rsplit(".", 1)[1].lower()
        file_id = uuid.uuid4().hex
        gcs_path = f"people-files/{email}/{pid}/{file_id}.{ext}" if ext else f"people-files/{email}/{pid}/{file_id}"
        content_type = f.mimetype or "application/octet-stream"
        file_bytes = f.read()
        result = gcs_upload_image(gcs_path, file_bytes, content_type=content_type)
        if not result:
            return jsonify({"error": "GCS 上傳失敗"}), 500

        meta = {
            "id": file_id,
            "gcs_path": gcs_path,
            "filename": f.filename,
            "mime_type": content_type,
            "uploaded_at": server_timestamp(),
            "uploaded_by": email,
        }

        # 若是音訊或對話截圖，自動 Gemini 產生逐字稿 + 摘要 + 關鍵字
        ai_result = None
        ai_kind = None  # 'audio' / 'image_conversation'
        if content_type.startswith("audio/"):
            ai_result = transcribe_audio(file_bytes, content_type)
            ai_kind = "audio" if ai_result else None
        elif content_type.startswith("image/"):
            ai_result = transcribe_image_conversation(file_bytes, content_type)
            ai_kind = "image_conversation" if ai_result else None
        if ai_result:
            meta["transcript"] = ai_result["transcript"]
            meta["summary"] = ai_result["summary"]
            meta["keywords"] = ai_result["keywords"]
            meta["ai_kind"] = ai_kind

        ref.collection("files").document(file_id).set(meta)
        ref.update({"updated_at": server_timestamp()})

        ai_emoji = "🎙️" if ai_kind == "audio" else ("💬" if ai_kind == "image_conversation" else "")
        ref.collection("timeline").add({
            "type": "file_uploaded",
            "display_text": f"上傳附件：{f.filename}" + (f" {ai_emoji}" if ai_emoji else ""),
            "payload": {"filename": f.filename, "file_id": file_id, "ai_kind": ai_kind},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })

        # 音訊或對話截圖：自動建一筆互動記事
        if ai_result:
            via_map = {"audio": "other", "image_conversation": "line"}
            contact_doc = {
                "content": ai_result["summary"] or ai_result["transcript"][:200],
                "via": via_map.get(ai_kind, "other"),
                "voice_recorded": ai_kind == "audio",
                "from_screenshot": ai_kind == "image_conversation",
                "transcript": ai_result["transcript"],
                "keywords": ai_result["keywords"],
                "ai_kind": ai_kind,
                "attachments": [{"gcs_path": gcs_path, "filename": f.filename, "mime_type": content_type}],
                "contact_at": server_timestamp(),
                "created_at": server_timestamp(),
                "created_by": email,
            }
            if ai_kind == "audio":
                contact_doc["audio_file_id"] = file_id
                contact_doc["audio_gcs_path"] = gcs_path
            else:
                contact_doc["screenshot_file_id"] = file_id
                contact_doc["screenshot_gcs_path"] = gcs_path
            c_ref = ref.collection("contacts").document()
            c_ref.set(contact_doc)
            ref.update({"last_contact_at": server_timestamp()})
            tl_label = "🎙️ 錄音摘要" if ai_kind == "audio" else "💬 對話摘要"
            ref.collection("timeline").add({
                "type": "voice_contact_added" if ai_kind == "audio" else "screenshot_contact_added",
                "display_text": f"{tl_label}：{(ai_result['summary'] or '')[:50]}",
                "payload": {"contact_id": c_ref.id, "filename": f.filename, "ai_kind": ai_kind},
                "occurred_at": server_timestamp(),
                "created_by": email,
            })

        # 把 timestamp 轉字串才能 jsonify
        meta_out = dict(meta)
        meta_out["uploaded_at"] = _now_utc().isoformat()
        meta_out["transcribed"] = bool(ai_result)
        return jsonify(meta_out), 201
    except Exception as e:
        logging.warning("File upload failed: %s", e)
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  線上錄音 → 自動逐字稿 + 摘要 + 互動記事
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/contacts/voice", methods=["POST"])
def upload_voice_contact(pid):
    """
    瀏覽器 MediaRecorder 錄音上傳。
    Form data: audio=<binary>（webm / mp4 / wav / m4a 都接受）
    自動：存 GCS → Gemini transcribe → 寫入 contacts + files
    回傳：{ok, contact_id, summary, transcript, keywords}
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    f = request.files.get("audio")
    if not f:
        return jsonify({"error": "未提供音訊"}), 400

    try:
        person_ref = db.collection("people").document(pid)
        snap = person_ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        content_type = f.mimetype or "audio/webm"
        ext_map = {
            "audio/webm": "webm", "audio/mp4": "mp4", "audio/m4a": "m4a",
            "audio/x-m4a": "m4a", "audio/mpeg": "mp3", "audio/mp3": "mp3",
            "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg",
        }
        ext = ext_map.get(content_type.lower(), "webm")
        file_id = uuid.uuid4().hex
        gcs_path = f"people-files/{email}/{pid}/voice-{file_id}.{ext}"
        audio_bytes = f.read()

        if not gcs_upload_image(gcs_path, audio_bytes, content_type=content_type):
            return jsonify({"error": "GCS 上傳失敗"}), 500

        # AI 轉檔
        ai_result = transcribe_audio(audio_bytes, content_type)
        if not ai_result:
            ai_result = {
                "transcript": "",
                "summary": "（AI 轉檔失敗，可手動補充）",
                "keywords": [],
            }

        filename = f.filename or f"voice-{_now_utc().strftime('%Y%m%d-%H%M%S')}.{ext}"

        # 存 files collection
        person_ref.collection("files").document(file_id).set({
            "id": file_id,
            "gcs_path": gcs_path,
            "filename": filename,
            "mime_type": content_type,
            "transcript": ai_result["transcript"],
            "summary": ai_result["summary"],
            "keywords": ai_result["keywords"],
            "uploaded_at": server_timestamp(),
            "uploaded_by": email,
            "from_voice_recording": True,
        })

        # 建一筆互動記事
        c_ref = person_ref.collection("contacts").document()
        c_ref.set({
            "content": ai_result["summary"] or ai_result["transcript"][:200],
            "via": "other",
            "voice_recorded": True,
            "transcript": ai_result["transcript"],
            "keywords": ai_result["keywords"],
            "audio_file_id": file_id,
            "audio_gcs_path": gcs_path,
            "attachments": [{"gcs_path": gcs_path, "filename": filename, "mime_type": content_type}],
            "contact_at": server_timestamp(),
            "created_at": server_timestamp(),
            "created_by": email,
        })
        person_ref.update({
            "last_contact_at": server_timestamp(),
            "updated_at": server_timestamp(),
        })
        person_ref.collection("timeline").add({
            "type": "voice_contact_added",
            "display_text": f"🎙️ 錄音摘要：{(ai_result['summary'] or '')[:50]}",
            "payload": {"contact_id": c_ref.id, "file_id": file_id},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })

        return jsonify({
            "ok": True,
            "contact_id": c_ref.id,
            "file_id": file_id,
            "summary": ai_result["summary"],
            "transcript": ai_result["transcript"],
            "keywords": ai_result["keywords"],
        }), 201
    except Exception as e:
        logging.warning("Voice upload failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/files", methods=["GET"])
def list_files(pid):
    """列出某人所有附件。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        docs = list(ref.collection("files").stream())
        items = []
        for d in docs:
            x = d.to_dict() or {}
            x["id"] = d.id
            v = x.get("uploaded_at")
            if v is not None and hasattr(v, "isoformat"):
                x["uploaded_at"] = v.isoformat()
            items.append(x)
        return jsonify({"items": items})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/files/<fid>", methods=["DELETE"])
def delete_file(pid, fid):
    """刪除單一附件（同時刪 GCS 與 Firestore metadata）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        person_ref = db.collection("people").document(pid)
        snap = person_ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        file_ref = person_ref.collection("files").document(fid)
        fsnap = file_ref.get()
        if not fsnap.exists:
            return jsonify({"error": "找不到附件"}), 404
        gcs_path = (fsnap.to_dict() or {}).get("gcs_path")
        if gcs_path:
            gcs_delete_blob(gcs_path)
        file_ref.delete()
        person_ref.update({"updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/people-file/<path:gcs_path>", methods=["GET"])
def serve_file(gcs_path):
    """代理讀取 GCS 檔案（避免直接公開 bucket）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    # 路徑必須以 people-files/{email}/ 開頭，避免讀別人的檔
    expected_prefix = f"people-files/{email}/"
    if not gcs_path.startswith(expected_prefix):
        return jsonify({"error": "無權存取"}), 403
    return gcs_serve_blob(gcs_path)


# ══════════════════════════════════════════
#  漸進式連結：人 ↔ 既有 buyer / seller_prospect doc
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/link/<kind>/<target_id>", methods=["POST"])
def link_legacy(pid, kind, target_id):
    """
    手動把 person 連結到既有的 buyer / seller_prospect doc。
    kind = "buyer" | "seller"
    """
    if kind not in ("buyer", "seller"):
        return jsonify({"error": "kind 只能是 buyer / seller"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        field = "legacy_buyer_id" if kind == "buyer" else "legacy_seller_id"
        ref.update({field: target_id, "updated_at": server_timestamp()})
        ref.collection("timeline").add({
            "type": "legacy_linked",
            "display_text": f"連結到既有{kind}資料",
            "payload": {"kind": kind, "target_id": target_id},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/link/<kind>", methods=["DELETE"])
def unlink_legacy(pid, kind):
    """解除連結。"""
    if kind not in ("buyer", "seller"):
        return jsonify({"error": "kind 只能是 buyer / seller"}), 400
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        ref = db.collection("people").document(pid)
        snap = ref.get()
        if not snap.exists or (snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        field = "legacy_buyer_id" if kind == "buyer" else "legacy_seller_id"
        ref.update({field: None, "updated_at": server_timestamp()})
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════
#  關聯（人 ↔ 人，雙向同步寫）
# ══════════════════════════════════════════

@bp.route("/api/people/<pid>/members/<member_pid>", methods=["POST"])
def add_member(pid, member_pid):
    """加群組成員（必須 is_group=True）。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    if pid == member_pid:
        return jsonify({"error": "不能加自己"}), 400
    try:
        gref = db.collection("people").document(pid)
        gsnap = gref.get()
        if not gsnap.exists or (gsnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此群組"}), 404
        gd = gsnap.to_dict() or {}
        if not gd.get("is_group"):
            return jsonify({"error": "對象不是群組"}), 400
        # 確認成員存在
        msnap = db.collection("people").document(member_pid).get()
        if not msnap.exists or (msnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到該成員"}), 404
        members = list(gd.get("members") or [])
        if member_pid in members:
            return jsonify({"ok": True, "members": members, "noop": True})
        members.append(member_pid)
        gref.update({"members": members, "updated_at": server_timestamp()})
        gref.collection("timeline").add({
            "type": "member_added",
            "display_text": f"加入成員：{(msnap.to_dict() or {}).get('name')}",
            "payload": {"member_pid": member_pid},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        return jsonify({"ok": True, "members": members})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/members/<member_pid>", methods=["DELETE"])
def remove_member(pid, member_pid):
    """移除群組成員。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    try:
        gref = db.collection("people").document(pid)
        gsnap = gref.get()
        if not gsnap.exists or (gsnap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此群組"}), 404
        gd = gsnap.to_dict() or {}
        if not gd.get("is_group"):
            return jsonify({"error": "對象不是群組"}), 400
        members = [m for m in (gd.get("members") or []) if m != member_pid]
        gref.update({"members": members, "updated_at": server_timestamp()})
        return jsonify({"ok": True, "members": members})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/mentions", methods=["GET"])
def find_mentions(pid):
    """
    找所有「在哪些 contact 中被 @ 到」。
    跨 people 的 contacts collection 全掃（資料量小於 1000 筆勉強可接受；
    未來可改成 collection group query 加索引）。
    回傳：{ items: [{from_person_id, from_person_name, contact_id, content, contact_at, mentions:[]}] }
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"items": [], "error": "Firestore 未初始化"}), 503
    try:
        # collection group 查詢需要索引；先用 stream + filter
        all_people = list(db.collection("people").where("created_by", "==", email).stream())
        items = []
        for pdoc in all_people:
            pdata = pdoc.to_dict() or {}
            if pdata.get("deleted_at"):
                continue
            for cdoc in pdoc.reference.collection("contacts").stream():
                cdata = cdoc.to_dict() or {}
                mentions = cdata.get("mentions") or []
                if not mentions:
                    continue
                hit = any((m.get("person_id") == pid or m.get("person_id") == "@all") for m in mentions if isinstance(m, dict))
                if not hit:
                    continue
                items.append({
                    "from_person_id": pdoc.id,
                    "from_person_name": pdata.get("name"),
                    "from_is_group": bool(pdata.get("is_group")),
                    "contact_id": cdoc.id,
                    "content": cdata.get("content"),
                    "contact_at": (cdata.get("contact_at").isoformat() if hasattr(cdata.get("contact_at"), "isoformat") else cdata.get("contact_at")),
                    "mentions": mentions,
                })
        items.sort(key=lambda x: x.get("contact_at") or "", reverse=True)
        return jsonify({"items": items})
    except Exception as e:
        logging.warning("find_mentions failed: %s", e)
        return jsonify({"items": [], "error": str(e)}), 500


@bp.route("/api/people/<pid>/relations", methods=["POST"])
def add_relation(pid):
    """
    新增關聯。同時更新 A.relations 與 B.relations（雙向）。
    Body: { "person_id": "<other_pid>", "relation": "spouse|parent|...", "note": "" }
    關聯類型若為有向（introduced_by / introduced），自動寫對偶。
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    data = request.get_json(silent=True) or {}
    other_id = data.get("person_id")
    relation = str(data.get("relation", "")).strip()
    note = str(data.get("note", "") or "").strip()

    if not other_id or not relation:
        return jsonify({"error": "person_id 與 relation 必填"}), 400
    if relation not in VALID_RELATION_TYPES:
        return jsonify({"error": f"relation 只能是 {VALID_RELATION_TYPES}"}), 400
    if other_id == pid:
        return jsonify({"error": "不能關聯自己"}), 400

    # 對偶關係映射
    DUAL = {
        "spouse": "spouse", "sibling": "sibling", "friend": "friend", "partner": "partner",
        "parent": "child", "child": "parent",
        "introduced_by": "introduced", "introduced": "introduced_by",
        "other": "other",
    }
    dual_relation = DUAL.get(relation, "other")

    try:
        a_ref = db.collection("people").document(pid)
        b_ref = db.collection("people").document(other_id)
        a_snap = a_ref.get()
        b_snap = b_ref.get()
        if not a_snap.exists or (a_snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404
        if not b_snap.exists or (b_snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到對方"}), 404

        a_dict = a_snap.to_dict() or {}
        b_dict = b_snap.to_dict() or {}
        a_rels = a_dict.get("relations", []) or []
        b_rels = b_dict.get("relations", []) or []

        # 去重：同一對 (person_id, relation) 不重複加
        a_rels = [r for r in a_rels if not (r.get("person_id") == other_id and r.get("relation") == relation)]
        b_rels = [r for r in b_rels if not (r.get("person_id") == pid and r.get("relation") == dual_relation)]

        a_rels.append({"person_id": other_id, "relation": relation, "note": note})
        b_rels.append({"person_id": pid, "relation": dual_relation, "note": note})

        a_ref.update({"relations": a_rels, "updated_at": server_timestamp()})
        b_ref.update({"relations": b_rels, "updated_at": server_timestamp()})

        # Timeline 事件（雙向各寫一條）
        b_name = b_dict.get("name", "")
        a_name = a_dict.get("name", "")
        a_ref.collection("timeline").add({
            "type": "relation_added",
            "display_text": f"加關聯：{relation} ↔ {b_name}",
            "payload": {"with": other_id, "relation": relation},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })
        b_ref.collection("timeline").add({
            "type": "relation_added",
            "display_text": f"加關聯：{dual_relation} ↔ {a_name}",
            "payload": {"with": pid, "relation": dual_relation},
            "occurred_at": server_timestamp(),
            "created_by": email,
        })

        return jsonify({"ok": True, "relations": a_rels})
    except Exception as e:
        logging.warning("Relation add failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/relations", methods=["DELETE"])
def remove_relation(pid):
    """
    移除關聯（雙向同步刪）。
    Query: ?person_id=<other_pid>&relation=<rel>
    """
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    other_id = request.args.get("person_id", "")
    relation = request.args.get("relation", "")
    if not other_id or not relation:
        return jsonify({"error": "person_id 與 relation 必填"}), 400

    try:
        a_ref = db.collection("people").document(pid)
        b_ref = db.collection("people").document(other_id)
        a_snap = a_ref.get()
        b_snap = b_ref.get()
        if not a_snap.exists or (a_snap.to_dict() or {}).get("created_by") != email:
            return jsonify({"error": "找不到此人"}), 404

        a_rels = (a_snap.to_dict() or {}).get("relations", []) or []
        a_rels_new = [r for r in a_rels if not (r.get("person_id") == other_id and r.get("relation") == relation)]
        a_ref.update({"relations": a_rels_new, "updated_at": server_timestamp()})

        # 對偶刪除（若對方存在）
        if b_snap.exists and (b_snap.to_dict() or {}).get("created_by") == email:
            b_rels = (b_snap.to_dict() or {}).get("relations", []) or []
            b_rels_new = [r for r in b_rels if r.get("person_id") != pid or r.get("relation") not in (relation,)]
            # 簡化：只要對方紀錄中 person_id == pid 一律移除
            b_rels_new = [r for r in b_rels if r.get("person_id") != pid]
            b_ref.update({"relations": b_rels_new, "updated_at": server_timestamp()})

        return jsonify({"ok": True, "relations": a_rels_new})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
