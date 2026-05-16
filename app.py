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
import time
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

# 靜態檔版本號：用行程啟動時間（每次部署＝新 Cloud Run revision＝新行程＝新值）。
# 模板用 ?v={{ STATIC_VER }} 掛在 .js/.css 後面 → 部署後瀏覽器一定抓新檔，
# 不會再有「改了卻還是舊版（快取）」的問題。
app.jinja_env.globals["STATIC_VER"] = str(int(time.time()))


# ── Auth + Blueprints ──
from auth import init_auth
from blueprints import people_bp, roles_bp, contacts_bp, groups_bp, feedback_bp, properties_bp

init_auth(app)
app.register_blueprint(people_bp)
app.register_blueprint(roles_bp)
app.register_blueprint(contacts_bp)
app.register_blueprint(groups_bp)
app.register_blueprint(feedback_bp)
app.register_blueprint(properties_bp)


# ══════════════════════════════════════════
#  系統路由
# ══════════════════════════════════════════

@app.after_request
def _no_html_cache(resp):
    """HTML 頁面一律不准快取（含 iOS bfcache）。
    根治「部署了新版、使用者卻一直看到舊頁面（連整頁版面/內嵌樣式都是舊的）」
    —— no-store 會讓瀏覽器每次都重抓 HTML，並停用回上一頁的記憶頁(bfcache)，
    HTML 內的 ?v={{STATIC_VER}} 再保證 JS/CSS 也是新的。靜態檔不受影響（有版本號）。
    """
    try:
        ct = (resp.headers.get("Content-Type") or "")
        if ct.startswith("text/html"):
            resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            resp.headers["Pragma"] = "no-cache"
            resp.headers["Expires"] = "0"
    except Exception:
        pass
    return resp


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


@app.route("/people/<pid>")
def detail_page(pid):
    """卡片詳情頁。權限驗證在前端透過 /api/people/<id> 做。"""
    PORTAL_URL = (os.environ.get("PORTAL_URL") or "").strip()
    if not session.get("user_email"):
        from flask import redirect
        return redirect(PORTAL_URL or "/auth/portal-login")
    return render_template(
        "detail.html",
        user_email=session.get("user_email", ""),
        user_name=session.get("user_name", ""),
        portal_url=PORTAL_URL,
        person_id=pid,
    )


@app.route("/groups")
def groups_page():
    """[已棄用] 群組現在統一在 /people 列表中（is_group=true 卡片）。
    舊連結重導到主列表，並用顯示模式自動切到「只看群組」。"""
    from flask import redirect
    return redirect("/?show=groups")


@app.route("/find-or-create")
def find_or_create_page():
    """智慧路由：從 LIBRARY/其他工具點所有權人時跳這裡。
    URL 參數：?name=李文雄&prop=cp_doc_id&phone=...&contact=...&address=...&category=...&price=...&case=...
    流程：
      - 名稱 + 電話比對既有 people
      - 找到 → 直接 redirect 到 /people/<id>
      - 沒找到 → 顯示確認頁，點「建立」 → 建 person + 加 property → 跳 /people/<new_id>
    """
    PORTAL_URL = (os.environ.get("PORTAL_URL") or "").strip()
    if not session.get("user_email"):
        from flask import redirect
        return redirect(PORTAL_URL or "/auth/portal-login")
    from flask import request as _req
    return render_template(
        "find_or_create.html",
        user_email=session.get("user_email", ""),
        user_name=session.get("user_name", ""),
        portal_url=PORTAL_URL,
        q_name=_req.args.get("name", ""),
        q_phone=_req.args.get("phone", ""),
        q_contact=_req.args.get("contact", ""),
        q_address=_req.args.get("address", ""),
        q_category=_req.args.get("category", ""),
        q_price=_req.args.get("price", ""),
        q_case=_req.args.get("case", ""),
        q_prop=_req.args.get("prop", ""),
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
