# -*- coding: utf-8 -*-
"""
音訊處理 helper — Gemini transcribe（複用自 real-estate-buyer）。
回傳 {transcript, summary, keywords} 或 None（失敗）。
"""

import os
import json
import logging

try:
    import google.generativeai as genai
    _GEMINI_OK = True
except ImportError:
    _GEMINI_OK = False


def transcribe_audio(audio_bytes: bytes, mime_type: str):
    """
    將錄音檔丟給 Gemini，取得逐字稿、摘要、關鍵字。
    回傳：{"transcript": str, "summary": str, "keywords": [str]} 或 None
    """
    if not _GEMINI_OK:
        return None
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = (
            "你是房仲業務助理。請聽這段錄音（可能是與買方/賣方對話、看房筆記或備忘），"
            "用繁體中文（台灣）回傳 JSON：\n"
            '{"transcript": "完整逐字稿", "summary": "1~2 句重點摘要", "keywords": ["3~6 個關鍵字"]}\n'
            "只回 JSON，不要 markdown code block。"
        )
        cfg = genai.types.GenerationConfig(response_mime_type="application/json")
        response = model.generate_content(
            [{"mime_type": mime_type, "data": audio_bytes}, prompt],
            generation_config=cfg,
        )
        data = json.loads(response.text)
        return {
            "transcript": data.get("transcript", "") or "",
            "summary": data.get("summary", "") or "",
            "keywords": data.get("keywords", []) or [],
        }
    except Exception as e:
        logging.warning("transcribe_audio failed: %s", e)
        return None


def transcribe_image_conversation(image_bytes: bytes, mime_type: str):
    """
    若圖片是對話截圖（LINE/微信/簡訊），用 Gemini 視覺 → 逐字稿 + 摘要 + 關鍵字。
    若不是對話（物件照、合約、地圖等），回傳 None。
    回傳：{"transcript", "summary", "keywords"} 或 None
    """
    if not _GEMINI_OK:
        return None
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel("gemini-2.0-flash")
        prompt = (
            "你是房仲業務助理。請判斷這張圖片是不是對話截圖（LINE / 微信 / 簡訊 / 其他即時通訊）。\n\n"
            "若**是**對話截圖，用繁體中文（台灣）回傳：\n"
            '{"is_conversation": true, '
            '"transcript": "完整對話逐字稿（每句前標明 [我] 或 [對方] 或具體名字）", '
            '"summary": "1-2 句重點摘要（這次對話在談什麼）", '
            '"keywords": ["3-6 個關鍵字"]}\n\n'
            "若**不是**對話截圖（例如物件照、合約照、地圖、文件、收據），回傳：\n"
            '{"is_conversation": false}\n\n'
            "只回 JSON，不要 markdown code block。"
        )
        cfg = genai.types.GenerationConfig(response_mime_type="application/json")
        response = model.generate_content(
            [{"mime_type": mime_type, "data": image_bytes}, prompt],
            generation_config=cfg,
        )
        data = json.loads(response.text)
        if not data.get("is_conversation"):
            return None
        return {
            "transcript": data.get("transcript", "") or "",
            "summary": data.get("summary", "") or "",
            "keywords": data.get("keywords", []) or [],
        }
    except Exception as e:
        logging.warning("transcribe_image_conversation failed: %s", e)
        return None
