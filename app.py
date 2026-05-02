# -*- coding: utf-8 -*-
"""
房仲工具 — 人脈管理（real-estate-people）

統一管理買方/賣方/介紹人/同業/朋友等所有「人」。
本服務按 Blueprint 拆分，避免單檔過大：
  blueprints/people.py     主檔 CRUD + 頭像 + 附件 + 漸進連結 + 關聯
  blueprints/roles.py      角色 CRUD（buyer / seller / 等）—— Phase 1.2 加入
  blueprints/contacts.py   互動記事 + timeline —— Phase 1.2 加入
  blueprints/groups.py     群組 —— Phase 1.2 加入

Firestore 集合：
  people/{id}                          主檔
  people/{id}/roles/{role_type}        角色子文件
  people/{id}/contacts/{cid}           互動記事
  people/{id}/timeline/{eid}           來時路事件
  people/{id}/files/{fid}              附件 metadata
  people_groups/{gid}                  群組
"""

import os
import logging
from datetime import timedelta

from flask import Flask, request, jsonify, render_template, session

# ── 讀取 .env（本地開發） ──
try:
    from dotenv import load_dotenv
    _dir = os.path.dirname(os.path.abspath(__file__))
    for p in (os.path.join(_dir, ".env"), os.path.join(_dir, "..", ".env")):
        if os.path.isfile(p):
            load_dotenv(p, override=False)
            break
except Exception:
    pass


# ── Flask app ──
app = Flask(__name__, template_folder="templates", static_folder="static")
_secret = os.environ.get("FLASK_SECRET_KEY", "")
if not _secret:
    logging.warning("FLASK_SECRET_KEY 未設定，使用 dev key（部署後請務必補環境變數）。")
app.secret_key = _secret or "dev-only-insecure-key"
# SameSite=None：Portal 跨站跳轉時瀏覽器才能正確帶 session cookie
app.config["SESSION_COOKIE_SAMESITE"] = "None"
app.config["SESSION_COOKIE_SECURE"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)


# ── Auth + Blueprints ──
from auth import init_auth
from blueprints import people_bp

init_auth(app)
app.register_blueprint(people_bp)


# ══════════════════════════════════════════
#  系統路由
# ══════════════════════════════════════════

@app.route("/health")
def health():
    return {"service": "real-estate-people", "status": "ok"}, 200


@app.route("/")
def index():
    """首頁：未登入導 Portal，已登入 render 列表頁。"""
    PORTAL_URL = (os.environ.get("PORTAL_URL") or "").strip()
    if not session.get("user_email"):
        from flask import redirect
        return redirect(PORTAL_URL or "/auth/portal-login")
    return render_template(
        "index.html",
        user_email=session.get("user_email", ""),
        user_name=session.get("user_name", ""),
        user_picture=session.get("user_picture", ""),
        portal_url=PORTAL_URL,
    )


@app.route("/api/client-log", methods=["POST"])
def api_client_log():
    """接收前端 JS 錯誤，記錄至 Cloud Logging。"""
    data = request.get_json(silent=True) or {}
    print(f"[client_error] {data}", flush=True)
    return jsonify({"ok": True})


if __name__ == "__main__":
    # 本地開發：python app.py（預設 port 8080）
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=os.getenv("FLASK_DEBUG") == "1")
