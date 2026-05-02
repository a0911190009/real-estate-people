# -*- coding: utf-8 -*-
"""
一次性遷移腳本：把 real-estate-buyer/buyers 與 real-estate-library/seller_prospects
匯入 real-estate-people 的 people/ collection，掛上對應角色 + legacy_*_id 連結。

執行：
  python3 scripts/migrate_from_legacy.py            # dry-run（預覽，不寫入）
  python3 scripts/migrate_from_legacy.py --execute  # 實際寫入

設計原則：
  - 不修改既有 buyers/、seller_prospects/ 任何欄位（只讀）
  - 同電話的買方+準賣方合併成「一個人 + 兩個角色」
  - 沒電話的個別建立（無法 dedupe）
  - 失敗某筆不影響其他筆
"""

import os
import sys
import argparse
import re
from datetime import datetime, timezone, timedelta

# 確保能 import 同層模組
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from firestore_client import get_db, server_timestamp


MY_EMAIL = "a0911190009@gmail.com"

# 改進建議（無對應欄位的紀錄）
IMPROVEMENT_NOTES = []


# ─────────────── 輔助 ───────────────

def normalize_phone(s):
    """去除空白、橫線、括號等，留數字。回傳 '' 表示沒有有效電話。"""
    if not s:
        return ''
    digits = re.sub(r'\D', '', str(s))
    return digits


def parse_dt(s):
    """把舊資料的 datetime 字串解析回 datetime（容錯多種格式）。"""
    if not s:
        return None
    if hasattr(s, 'isoformat'):
        return s
    if isinstance(s, str):
        for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d'):
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=timezone(timedelta(hours=8)))
            except ValueError:
                pass
    return None


def strip_b64_prefix(s):
    """把 'data:image/jpeg;base64,xxx' 的 prefix 去掉，只留純 base64。"""
    if not s:
        return None
    if isinstance(s, str) and s.startswith('data:'):
        idx = s.find(',')
        if idx > 0:
            return s[idx+1:]
    return s


# ─────────────── 角色資料規格化 ───────────────

VALID_BUYER_STATUSES = {'洽談中', '持續看物件', '暫無需求', '保持連繫', '成交', '流失'}
VALID_SELLER_STATUSES = {'培養中', '已報價', '已簽委託', '已成交', '放棄'}
VALID_CATEGORIES = {'透天', '別墅', '農舍', '公寓', '華廈', '套房',
                    '建地', '農地', '店面', '店住', '房屋', '其他'}


def build_buyer_role(b):
    """從 buyer doc 萃取出 buyer role 資料。"""
    status = b.get('status') or '洽談中'
    if status not in VALID_BUYER_STATUSES:
        IMPROVEMENT_NOTES.append(f"未知買方狀態 '{status}'，預設改為 '洽談中'")
        status = '洽談中'

    cat_pref = []
    types = b.get('types') or []
    if isinstance(types, list):
        for t in types:
            if t in VALID_CATEGORIES:
                cat_pref.append(t)
            elif t:
                IMPROVEMENT_NOTES.append(f"未知買方類別 '{t}'（doc {b.get('_id', '?')}）")

    area_pref = []
    area = b.get('area')
    if area:
        # area 是字串，可能含逗號/全形或描述。先當單筆塞進去，不切分
        area_pref = [str(area).strip()]

    size_indoor = {}
    if b.get('size_min') is not None:
        size_indoor['min'] = b['size_min']
    if b.get('size_max') is not None:
        size_indoor['max'] = b['size_max']

    role = {
        'status': status,
        'budget_max': b.get('budget_max'),
        'category_pref': cat_pref,
        'area_pref': area_pref,
        'size_indoor': size_indoor,
        # 其他欄位先不填，讓使用者後續補
    }

    # buyer.note 雖然是描述需求，但放到 role 沒適合欄位 → 放到 special_needs
    if b.get('note'):
        role['special_needs'] = str(b['note']).strip()

    return role


def build_seller_role(s):
    """從 seller_prospect doc 萃取出 seller role 資料。"""
    status = s.get('status') or '培養中'
    if status not in VALID_SELLER_STATUSES:
        IMPROVEMENT_NOTES.append(f"未知賣方狀態 '{status}'，預設改為 '培養中'")
        status = '培養中'

    category = s.get('category') or None
    if category and category not in VALID_CATEGORIES:
        IMPROVEMENT_NOTES.append(f"未知賣方類別 '{category}'（doc {s.get('_id', '?')}）")
        category = None

    role = {
        'status': status,
        'property_address': s.get('address') or None,
        'land_number': s.get('land_number') or None,
        'category': category,
        'owner_price': s.get('owner_price'),
    }
    # suggest_price 沒有對應欄位 → 加進 motivation 備註
    if s.get('suggest_price') is not None:
        role['motivation'] = f"原系統建議價：{s['suggest_price']} 萬"
        IMPROVEMENT_NOTES.append(
            f"準賣方 suggest_price 欄位無 1:1 對應，已併入 motivation"
        )
    return role


# ─────────────── 主邏輯 ───────────────

def collect_legacy(db, email):
    """讀取舊資料。回傳 (buyers, sellers) 兩個 list of (id, dict)。"""
    print(f'\n讀取使用者 {email} 的舊資料...')
    buyers = []
    for d in db.collection('buyers').where('created_by', '==', email).stream():
        data = d.to_dict() or {}
        data['_id'] = d.id
        buyers.append(data)
    sellers = []
    for d in db.collection('seller_prospects').where('created_by', '==', email).stream():
        data = d.to_dict() or {}
        data['_id'] = d.id
        sellers.append(data)
    print(f'  買方 {len(buyers)} 筆、準賣方 {len(sellers)} 筆')
    return buyers, sellers


def build_merge_plan(buyers, sellers):
    """
    依電話 normalize 合併。回傳 list of dict：
      { 'name', 'phone', 'buyer': buyer_doc | None, 'seller': sp_doc | None }
    """
    by_phone = {}
    no_phone_items = []

    for b in buyers:
        ph = normalize_phone(b.get('phone'))
        if not ph:
            no_phone_items.append({'name': b.get('name'), 'phone': '', 'buyer': b, 'seller': None})
            continue
        by_phone.setdefault(ph, {'phone': ph, 'buyer': None, 'seller': None})['buyer'] = b

    for s in sellers:
        ph = normalize_phone(s.get('phone'))
        if not ph:
            no_phone_items.append({'name': s.get('name'), 'phone': '', 'buyer': None, 'seller': s})
            continue
        by_phone.setdefault(ph, {'phone': ph, 'buyer': None, 'seller': None})['seller'] = s

    plan = list(by_phone.values()) + no_phone_items

    # 補上每筆的 display name（優先用 buyer name）
    for p in plan:
        b = p.get('buyer')
        s = p.get('seller')
        if b and s and (b.get('name') != s.get('name')):
            # 同電話兩個 name 不同，合併紀錄
            p['name'] = b.get('name') or s.get('name')
            p['_name_conflict'] = (b.get('name'), s.get('name'))
        else:
            p['name'] = (b or s).get('name') or '(未命名)'
    return plan


def execute_plan(db, plan, dry_run=True):
    """實際建立 people doc。"""
    created = 0
    skipped = 0
    errors = []

    for idx, item in enumerate(plan, 1):
        b = item.get('buyer')
        s = item.get('seller')
        name = item['name']
        phone = item['phone']

        # 主檔
        contacts = []
        if phone:
            contacts.append({'type': 'mobile', 'value': phone, 'label': '本人'})

        # 找頭像（buyer 有 photo_b64，seller 通常沒有）
        avatar = None
        if b and b.get('photo_b64'):
            avatar = strip_b64_prefix(b['photo_b64'])

        # 來源（從 seller.source 取）
        source = {'channel': 'other', 'referrer_person_id': None, 'note': ''}
        if s and s.get('source'):
            source['note'] = str(s['source']).strip()

        # 警示語：用名稱 conflict 提示
        warning = None
        if item.get('_name_conflict'):
            n1, n2 = item['_name_conflict']
            warning = f'同電話兩個身份合併：買方「{n1}」+ 準賣方「{n2}」'

        # last_contact_at
        last_contact = None
        if s and s.get('last_contact_at'):
            last_contact = s['last_contact_at']
        # 也可能 buyer 有 updated_at 視為 last_contact

        person_payload = {
            'name': name,
            'display_name': None,
            'birthday': None,
            'zodiac': None,
            'gender': None,
            'company': None,
            'avatar_b64': avatar,
            'contacts': contacts,
            'addresses': [],
            'bucket': 'normal',
            'warning': warning,
            'source': source,
            'active_roles': [],  # 寫角色時 _refresh_active_roles 會更新；遷移時手動填
            'relations': [],
            'legacy_buyer_id': b['_id'] if b else None,
            'legacy_seller_id': s['_id'] if s else None,
            'last_contact_at': last_contact,
            'deleted_at': None,
            'created_by': MY_EMAIL,
            'created_at': server_timestamp(),
            'updated_at': server_timestamp(),
        }

        active_roles = []
        if b:
            active_roles.append('buyer')
        if s:
            active_roles.append('seller')
        person_payload['active_roles'] = active_roles

        prefix = f'[{idx}/{len(plan)}]'
        roles_label = '+'.join(active_roles)
        print(f'  {prefix} {name} ({phone or "無電話"}) → 角色 [{roles_label}]'
              + (f'  ⚠️  名稱合併：{item["_name_conflict"]}' if item.get('_name_conflict') else ''))

        if dry_run:
            created += 1
            continue

        try:
            ref = db.collection('people').document()
            ref.set(person_payload)

            # 寫 timeline：from_legacy
            ref.collection('timeline').add({
                'type': 'migrated_from_legacy',
                'display_text': f'從舊系統遷入 ({roles_label})',
                'payload': {'legacy_buyer_id': b['_id'] if b else None,
                            'legacy_seller_id': s['_id'] if s else None},
                'occurred_at': server_timestamp(),
                'created_by': MY_EMAIL,
            })

            # buyer role 子文件
            if b:
                role_data = build_buyer_role(b)
                role_data['created_at'] = server_timestamp()
                role_data['updated_at'] = server_timestamp()
                role_data['archived_at'] = None
                role_data['created_by'] = MY_EMAIL
                ref.collection('roles').document('buyer').set(role_data)
                ref.collection('timeline').add({
                    'type': 'role_added',
                    'display_text': f'加角色：buyer（從舊系統）',
                    'payload': {'role_type': 'buyer'},
                    'occurred_at': server_timestamp(),
                    'created_by': MY_EMAIL,
                })

            # seller role 子文件
            if s:
                role_data = build_seller_role(s)
                role_data['created_at'] = server_timestamp()
                role_data['updated_at'] = server_timestamp()
                role_data['archived_at'] = None
                role_data['created_by'] = MY_EMAIL
                ref.collection('roles').document('seller').set(role_data)
                ref.collection('timeline').add({
                    'type': 'role_added',
                    'display_text': f'加角色：seller（從舊系統）',
                    'payload': {'role_type': 'seller'},
                    'occurred_at': server_timestamp(),
                    'created_by': MY_EMAIL,
                })

            # buyer.note → 寫成一筆互動記事（保留歷史）
            if b and b.get('note'):
                ref.collection('contacts').add({
                    'content': f'[從舊系統匯入的需求備註]\n{b["note"]}',
                    'via': 'other',
                    'voice_recorded': False,
                    'attachments': [],
                    'contact_at': server_timestamp(),
                    'created_at': server_timestamp(),
                    'created_by': MY_EMAIL,
                })

            # seller.note → 寫成互動記事
            if s and s.get('note'):
                ref.collection('contacts').add({
                    'content': f'[從舊系統匯入的賣方備註]\n{s["note"]}',
                    'via': 'other',
                    'voice_recorded': False,
                    'attachments': [],
                    'contact_at': server_timestamp(),
                    'created_at': server_timestamp(),
                    'created_by': MY_EMAIL,
                })

            created += 1
        except Exception as e:
            errors.append((name, str(e)))
            print(f'    ❌ 失敗：{e}')

    return created, skipped, errors


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true', help='實際寫入；預設為 dry-run')
    parser.add_argument('--email', default=MY_EMAIL, help='只遷移此 created_by')
    args = parser.parse_args()

    db = get_db()
    if db is None:
        print('❌ Firestore 未初始化')
        sys.exit(1)

    buyers, sellers = collect_legacy(db, args.email)
    plan = build_merge_plan(buyers, sellers)

    print(f'\n=== 計畫：建立 {len(plan)} 個 people doc ===')
    print(f'(模式：{"執行" if args.execute else "DRY-RUN（不寫入）"})')
    print()

    created, skipped, errors = execute_plan(db, plan, dry_run=not args.execute)

    print()
    print('=== 完成 ===')
    print(f'  建立 {created} 個 person')
    if errors:
        print(f'  ❌ 失敗 {len(errors)}：')
        for n, e in errors:
            print(f'    - {n}: {e}')
    if IMPROVEMENT_NOTES:
        print(f'\n=== 改進建議（待寫入 improvement_logs）===')
        from collections import Counter
        for note, n in Counter(IMPROVEMENT_NOTES).most_common():
            print(f'  ({n}x) {note}')

    if not args.execute:
        print('\n→ 預覽 OK 後加 --execute 實際執行')


if __name__ == '__main__':
    main()
