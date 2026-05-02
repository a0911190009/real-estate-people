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

from auth import require_user
from firestore_client import get_db, server_timestamp
from gcs_helpers import gcs_upload_image, gcs_delete_blob, gcs_serve_blob


bp = Blueprint("people", __name__)

# ─────────────── 常數 ───────────────

VALID_BUCKETS = {"primary", "normal", "frozen", "closed", "blacklist"}
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
        result = gcs_upload_image(gcs_path, f.read(), content_type=content_type)
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
        ref.collection("files").document(file_id).set(meta)
        ref.update({"updated_at": server_timestamp()})

        # 把 timestamp 轉字串才能 jsonify
        meta_out = dict(meta)
        meta_out["uploaded_at"] = _now_utc().isoformat()
        return jsonify(meta_out), 201
    except Exception as e:
        logging.warning("File upload failed: %s", e)
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
