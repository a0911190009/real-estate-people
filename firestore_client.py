# -*- coding: utf-8 -*-
"""
Firestore client 延遲初始化（共用模組）。
- 第一次呼叫 _get_db() 才會建立連線
- 失敗時回傳 None，呼叫端要做 None check
"""

import os
import logging

try:
    from google.cloud import firestore as _firestore
except ImportError:
    _firestore = None

_db = None


def get_db():
    """取得 Firestore client（延遲初始化）。失敗回傳 None。"""
    global _db
    if _db is not None:
        return _db
    if _firestore is None:
        return None
    try:
        _db = _firestore.Client(
            project=os.environ.get("GOOGLE_CLOUD_PROJECT") or os.environ.get("GCLOUD_PROJECT")
        )
        return _db
    except Exception as e:
        logging.warning("People: Firestore 初始化失敗: %s", e)
        return None


def server_timestamp():
    """回傳 Firestore SERVER_TIMESTAMP sentinel（寫入時自動由 server 填入時間）。"""
    if _firestore is None:
        return None
    return _firestore.SERVER_TIMESTAMP


def array_union(*values):
    """Firestore ArrayUnion sentinel（陣列欄位加值不重複）。"""
    if _firestore is None:
        return None
    return _firestore.ArrayUnion(list(values))


def array_remove(*values):
    """Firestore ArrayRemove sentinel。"""
    if _firestore is None:
        return None
    return _firestore.ArrayRemove(list(values))


def increment(n=1):
    """Firestore Increment sentinel（原子加減）。"""
    if _firestore is None:
        return None
    return _firestore.Increment(n)
