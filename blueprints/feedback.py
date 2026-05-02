# -*- coding: utf-8 -*-
"""
回饋系統 — 寫入 improvement_logs collection（與 portal 共用 Firestore）。
路由：POST /api/feedback（給 feedback-widget.js 呼叫）

設計原則：
  - 直接寫 Firestore（people 與 portal 同 GCP project）
  - 截圖上傳到 GCS 同 bucket，路徑 feedback/{date}/{uuid}.{ext}
  - 不需透過 portal API 中轉
"""

import os
import uuid
import hashlib
import logging
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify

from auth import require_user
from firestore_client import get_db, server_timestamp
from gcs_helpers import gcs_upload_image


bp = Blueprint("feedback", __name__)


VALID_FB_TYPES = {"bug", "missing_field", "feature", "ux", "other"}
VALID_FB_TOOLS = {"portal", "people", "buyer", "seller", "library", "ad",
                  "survey", "calendar", "price", "doc", "notes", "thumbnail", "other"}


def _similarity_hash(tool, type_, title, content):
    base = f"{tool}|{type_}|{(title or '')[:30]}|{(content or '')[:60]}"
    return hashlib.md5(base.encode("utf-8")).hexdigest()[:16]


@bp.route("/api/feedback", methods=["POST"])
def submit_feedback():
    """接收 widget 送來的回報，寫入 improvement_logs collection。"""
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    db = get_db()
    if db is None:
        return jsonify({"error": "Firestore 未初始化"}), 503

    tool = (request.form.get("tool") or "people").strip()
    if tool not in VALID_FB_TOOLS:
        tool = "other"
    type_ = (request.form.get("type") or "other").strip()
    if type_ not in VALID_FB_TYPES:
        type_ = "other"
    title = (request.form.get("title") or "").strip()
    content = (request.form.get("content") or "").strip()
    if not title and not content:
        return jsonify({"error": "title 與 content 至少填一個"}), 400
    page_url = (request.form.get("page_url") or "").strip()

    # 截圖上傳到 GCS
    screenshots = []
    files = request.files.getlist("screenshots") or []
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    for f in files[:3]:
        if not f or not f.filename:
            continue
        ext = ""
        if "." in f.filename:
            ext = f.filename.rsplit(".", 1)[1].lower()
        fid = uuid.uuid4().hex[:12]
        gcs_path = f"feedback/{date_str}/{fid}.{ext}" if ext else f"feedback/{date_str}/{fid}"
        content_type = f.mimetype or "application/octet-stream"
        if gcs_upload_image(gcs_path, f.read(), content_type=content_type):
            screenshots.append({
                "gcs_path": gcs_path,
                "filename": f.filename,
                "mime_type": content_type,
            })

    payload = {
        "tool": tool,
        "type": type_,
        "source": "user_reported",
        "title": title,
        "content": content,
        "context": {
            "page_url": page_url,
            "user_agent": request.headers.get("User-Agent", "")[:200],
        },
        "screenshots": screenshots,
        "count": 1,
        "similarity_hash": _similarity_hash(tool, type_, title, content),
        "status": "open",
        "priority": 5,
        "created_at": server_timestamp(),
        "updated_at": server_timestamp(),
        "resolved_at": None,
        "created_by": email,
    }
    try:
        ref = db.collection("improvement_logs").document()
        ref.set(payload)
        return jsonify({"ok": True, "id": ref.id}), 201
    except Exception as e:
        logging.warning("Feedback submit failed: %s", e)
        return jsonify({"error": str(e)}), 500
