# -*- coding: utf-8 -*-
"""
認證模組：
- Portal SSO token 驗證（/auth/portal-login）
- session 工具函式（_require_user / _is_admin）
- X-Service-Key 驗證（內部服務互呼）
"""

import os
import hmac
from datetime import timedelta

from flask import Blueprint, request, session, redirect, jsonify
from itsdangerous import URLSafeTimedSerializer, SignatureExpired, BadSignature


PORTAL_URL = (os.environ.get("PORTAL_URL") or "").strip()
ADMIN_EMAILS = [e.strip() for e in (os.environ.get("ADMIN_EMAILS") or "").split(",") if e.strip()]
SERVICE_API_KEY = (os.environ.get("SERVICE_API_KEY") or "").strip()
TOKEN_MAX_AGE = 300  # 5 分鐘，容忍 Cloud Run cold start

_serializer = None  # 由 init_auth 設定（需要 app.secret_key）

bp = Blueprint("auth", __name__)


def init_auth(app):
    """app 啟動時呼叫，把 serializer 綁到 app.secret_key。"""
    global _serializer
    _serializer = URLSafeTimedSerializer(app.secret_key)
    app.register_blueprint(bp)
    # 開發模式：自動模擬登入
    @app.before_request
    def _auto_login_dev():
        if os.getenv("SKIP_AUTH"):
            session.permanent = True
            session["user_email"] = "dev@test.com"
            session["user_name"] = "開發測試"


def require_user():
    """檢查 session 是否登入。回傳 (email, error_tuple_or_None)。"""
    email = session.get("user_email")
    if not email:
        return None, ("請先登入", 401)
    return email, None


def is_admin(email):
    return email in ADMIN_EMAILS


def verify_service_key():
    """驗證 X-Service-Key header（用於 Portal Agent 等內部呼叫）。"""
    if not SERVICE_API_KEY:
        return False
    key = request.headers.get("X-Service-Key", "")
    return hmac.compare_digest(key, SERVICE_API_KEY)


# ══════════════════════════════════════════
#  Routes
# ══════════════════════════════════════════

@bp.route("/auth/portal-login", methods=["GET", "POST"])
def auth_portal_login():
    """Portal 跳轉過來時，驗證 token 建立 session。"""
    token = request.form.get("token") or request.args.get("token", "")
    if not token or _serializer is None:
        return redirect(PORTAL_URL or "/")
    try:
        payload = _serializer.loads(token, salt="portal-sso", max_age=TOKEN_MAX_AGE)
    except (SignatureExpired, BadSignature, Exception):
        return redirect(PORTAL_URL or "/")
    email = payload.get("email", "")
    if not email:
        return redirect(PORTAL_URL or "/")
    session.permanent = True
    session["user_email"] = email
    session["user_name"] = payload.get("name", "")
    session["user_picture"] = payload.get("picture", "")
    session.modified = True
    # 直接 redirect 到首頁（同域，SameSite 不影響）
    return redirect("/")


@bp.route("/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"redirect": PORTAL_URL or "/"})


@bp.route("/api/me")
def api_me():
    email, err = require_user()
    if err:
        return jsonify({"error": err[0]}), err[1]
    return jsonify({
        "email": email,
        "name": session.get("user_name", ""),
        "picture": session.get("user_picture", ""),
        "is_admin": is_admin(email),
    })
