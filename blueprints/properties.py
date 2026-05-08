# -*- coding: utf-8 -*-
"""
人脈中的物件清單（賣方視角）

每筆 person 可以有多個物件，存在 people/{pid}/properties/ 子集合：
    {
        id (=doc id),
        source: 'company_property' | 'manual' | 'seller_prospect',
        source_ref: 對應的 company_properties doc id（若 source=company_property）
        case_name: 案名
        address: 物件地址
        category: 物件類別
        price: 售價（萬）
        commission_price: 委託價（萬）
        is_selling: 銷售中布林
        commission_date: 委託日（民國 / 西元日期字串）
        expiry_date: 委託到期日
        land_number: 地號
        size_indoor: 室內坪
        size_land: 地坪
        agent: 經紀人姓名
        contact_name: 連絡人姓名
        sale_reason: 售屋原因
        note: 備註
        created_at, updated_at
    }
"""
from __future__ import annotations
import logging

from flask import Blueprint, request, jsonify

from auth import require_user
from firestore_client import get_db, server_timestamp

bp = Blueprint("properties", __name__)


VALID_SOURCES = {"company_property", "manual", "seller_prospect"}


def _doc_to_dict(snap):
    """Firestore snapshot → dict，補上 id；timestamp 轉成字串"""
    if not snap.exists:
        return None
    d = snap.to_dict() or {}
    d["id"] = snap.id
    for k in ("created_at", "updated_at"):
        v = d.get(k)
        if hasattr(v, "isoformat"):
            try: d[k] = v.isoformat()
            except Exception: pass
    return d


def _build_payload(data: dict) -> dict:
    """從前端 dict 建立物件 payload。寬鬆驗證，前端送什麼就存什麼（白名單欄位）。"""
    WHITELIST = {
        "source", "source_ref",
        "case_name", "address", "category",
        "price", "commission_price", "bottom_price",
        "is_selling",
        "commission_date", "expiry_date",
        "land_number", "size_indoor", "size_land",
        "agent", "contact_name", "contact_phone",
        "sale_reason", "note",
        "status",  # 培養中/已委託/已成交/已下架...
    }
    out = {}
    for k, v in (data or {}).items():
        if k not in WHITELIST:
            continue
        if isinstance(v, str):
            v = v.strip()
            if v == "":
                v = None
        out[k] = v
    # source 預設 manual
    if not out.get("source"):
        out["source"] = "manual"
    if out["source"] not in VALID_SOURCES:
        out["source"] = "manual"
    return out


def _verify_owner(db, pid: str, email: str):
    """驗證 person 存在 + 是該使用者建立。回傳 (person_dict, error_response)。"""
    ref = db.collection("people").document(pid)
    snap = ref.get()
    if not snap.exists:
        return None, (jsonify({"error": "找不到此人"}), 404)
    person = snap.to_dict() or {}
    if person.get("created_by") != email:
        return None, (jsonify({"error": "找不到此人"}), 404)
    return person, None


# ─────────── API endpoints ───────────

@bp.route("/api/people/<pid>/properties", methods=["GET"])
def list_properties(pid):
    """列出某人的所有物件，依 created_at 降冪。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person, err_resp = _verify_owner(db, pid, email)
    if err_resp:
        return err_resp
    try:
        items = []
        for d in db.collection("people").document(pid).collection("properties").stream():
            items.append(_doc_to_dict(d))
        # 排序：銷售中優先、然後依案名
        items.sort(key=lambda x: (
            0 if x.get("is_selling") else 1,
            x.get("case_name") or "",
        ))
        return jsonify({"items": items, "total": len(items)})
    except Exception as e:
        logging.warning("list_properties failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/properties/<prop_id>", methods=["GET"])
def get_property(pid, prop_id):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person, err_resp = _verify_owner(db, pid, email)
    if err_resp:
        return err_resp
    try:
        snap = db.collection("people").document(pid).collection("properties").document(prop_id).get()
        result = _doc_to_dict(snap)
        if not result:
            return jsonify({"error": "找不到此物件"}), 404
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/properties", methods=["POST"])
def add_property(pid):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person, err_resp = _verify_owner(db, pid, email)
    if err_resp:
        return err_resp
    data = request.get_json(silent=True) or {}
    payload = _build_payload(data)
    payload["created_at"] = server_timestamp()
    payload["created_by"] = email
    payload["updated_at"] = server_timestamp()
    try:
        ref = db.collection("people").document(pid).collection("properties").document()
        ref.set(payload)
        # 確保人物有 seller 角色（加入 active_roles）
        active = list(person.get("active_roles") or [])
        if "seller" not in active:
            active.append("seller")
            db.collection("people").document(pid).update({"active_roles": active})
        return jsonify(_doc_to_dict(ref.get())), 201
    except Exception as e:
        logging.warning("add_property failed: %s", e)
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/properties/<prop_id>", methods=["PUT", "PATCH"])
def update_property(pid, prop_id):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person, err_resp = _verify_owner(db, pid, email)
    if err_resp:
        return err_resp
    data = request.get_json(silent=True) or {}
    payload = _build_payload(data)
    payload["updated_at"] = server_timestamp()
    try:
        ref = db.collection("people").document(pid).collection("properties").document(prop_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify({"error": "找不到此物件"}), 404
        ref.update(payload)
        return jsonify(_doc_to_dict(ref.get()))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/people/<pid>/properties/<prop_id>", methods=["DELETE"])
def delete_property(pid, prop_id):
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503
    person, err_resp = _verify_owner(db, pid, email)
    if err_resp:
        return err_resp
    try:
        ref = db.collection("people").document(pid).collection("properties").document(prop_id)
        if not ref.get().exists:
            return jsonify({"error": "找不到此物件"}), 404
        ref.delete()
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
