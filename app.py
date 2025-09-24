import os
import re
import threading
import time
import json
import sqlite3
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

from flask import Flask, jsonify, request, render_template, Response, stream_with_context
import pandas as pd
import requests


app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["DATA_LOADED"] = False


# -----------------------------
# Config
# -----------------------------
BASE_DIR = os.path.abspath(os.getcwd())
TXT_EXTENSIONS = {".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xls"}
DATA_DIR = os.path.join(BASE_DIR, "data")
SQLITE_DB_PATH = os.path.join(DATA_DIR, "coca.sqlite")


# -----------------------------
# Current selected Excel file
# -----------------------------
current_excel_file: Optional[str] = None

# Loading state
loading_thread: Optional[threading.Thread] = None
loading_cancelled: bool = False
loading_progress: Dict[str, Any] = {
    "running": False,
    "file": None,
    "current_sheet": None,
    "processed_words": 0,
    "total_words": 0,
    "percent": 0.0,
    "error": None,
    "latest_words": [],
}


def normalize_word(word: str) -> str:
    if word is None:
        return ""
    # Keep letters, apostrophes, hyphens; lower-case
    text = str(word).strip()
    text = re.sub(r"[^A-Za-z\-']+", " ", text).strip().lower()
    return text


def list_excel_files() -> List[Dict[str, Any]]:
    files: List[Dict[str, Any]] = []
    for name in os.listdir(BASE_DIR):
        path = os.path.join(BASE_DIR, name)
        if os.path.isfile(path):
            _, ext = os.path.splitext(name)
            if ext.lower() in EXCEL_EXTENSIONS:
                stat = os.stat(path)
                files.append({
                    "name": name,
                    "size": stat.st_size,
                    "mtime": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                })
    files.sort(key=lambda x: x["name"].lower())
    return files

 


def compute_total_rows(file_path: str) -> int:
    try:
        from openpyxl import load_workbook
        wb = load_workbook(filename=file_path, read_only=True, data_only=True)
        total = 0
        for ws in wb.worksheets:
            total += (ws.max_row or 0)
        return total
    except Exception:
        # Fallback: estimate by parsing sheets with pandas (slower)
        try:
            xls = pd.ExcelFile(file_path)
            total = 0
            for sheet in xls.sheet_names:
                df = xls.parse(sheet_name=sheet, header=None, dtype=str)
                total += df.shape[0]
            return total
        except Exception:
            return 0


def _rebuild_sqlite_from_excel(file_path: str) -> None:
    """Rebuild a single SQLite database from the given Excel file.
    - During rebuild, querying is disabled (handled by caller via flags)
    - After successful rebuild, mark DATA_LOADED=True
    Table schema columns: word_norm, word, phonetic, meaning, sheet, row_index
    """
    # Prepare excel reader (streaming)
    from openpyxl import load_workbook
    wb = load_workbook(filename=file_path, read_only=True, data_only=True)
    sheets = [ws.title for ws in wb.worksheets]

    # Create directory for DB if missing
    os.makedirs(DATA_DIR, exist_ok=True)

    # Create SQLite and write in one transaction
    con = sqlite3.connect(SQLITE_DB_PATH)
    cur = con.cursor()
    try:
        # Pragmas for faster build
        cur.execute("PRAGMA journal_mode=WAL;")
        cur.execute("PRAGMA synchronous=NORMAL;")
        cur.execute("PRAGMA temp_store=MEMORY;")

        cur.execute("DROP TABLE IF EXISTS entries;")
        cur.execute(
            """
            CREATE TABLE entries (
              id INTEGER PRIMARY KEY,
              word_norm TEXT NOT NULL,
              word TEXT,
              phonetic TEXT,
              meaning TEXT,
              sheet TEXT,
              row_index INTEGER
            );
            """
        )

        con.execute("BEGIN;")

        # Sampling config for preview
        SAMPLE_STEP = 10
        LATEST_LIMIT = 40
        loading_progress["latest_words"] = []

        insert_sql = (
            "INSERT INTO entries (word_norm, word, phonetic, meaning, sheet, row_index) VALUES (?, ?, ?, ?, ?, ?)"
        )

        # We reuse total_words computed by caller; processed_words is reset in caller
        for sheet in sheets:
            loading_progress["current_sheet"] = sheet
            ws = wb[sheet]
            # choose word column index based on worksheet column count
            max_cols = ws.max_column or 1
            word_col_idx = 1 if max_cols > 1 else 0
            # iterate and batch insert
            batch: List[Tuple[str, Optional[str], Optional[str], Optional[str], str, int]] = []
            for row_idx, row in enumerate(ws.iter_rows(values_only=True)):
                if loading_cancelled:
                    con.rollback()
                    raise RuntimeError("loading cancelled")
                # guard for row tuple shorter than expected
                word_raw = row[word_col_idx] if word_col_idx < len(row or ()) else None
                display_word = "" if word_raw is None else str(word_raw).strip()
                norm = normalize_word(display_word)
                # map optional columns 2 and 3 when present
                phonetic_val = row[2] if (row and len(row) > 2) else None
                meaning_val = row[3] if (row and len(row) > 3) else None
                phonetic = None if phonetic_val is None else str(phonetic_val)
                meaning = None if meaning_val is None else str(meaning_val)

                batch.append((norm, display_word or None, phonetic, meaning, sheet, int(row_idx)))

                loading_progress["processed_words"] += 1
                if display_word and (loading_progress["processed_words"] % SAMPLE_STEP == 0):
                    lw = loading_progress.get("latest_words", [])
                    lw.append(display_word)
                    if len(lw) > LATEST_LIMIT:
                        del lw[: len(lw) - LATEST_LIMIT]
                    loading_progress["latest_words"] = lw

                # flush in batches
                if len(batch) >= 10000:
                    cur.executemany(insert_sql, batch)
                    batch.clear()
                    # update percent after a chunk
                    total = loading_progress.get("total_words", 0) or 0
                    processed = loading_progress.get("processed_words", 0)
                    loading_progress["percent"] = (processed / total * 100.0) if total > 0 else 0.0

            if batch:
                cur.executemany(insert_sql, batch)
                batch.clear()
                total = loading_progress.get("total_words", 0) or 0
                processed = loading_progress.get("processed_words", 0)
                loading_progress["percent"] = (processed / total * 100.0) if total > 0 else 0.0

        # index after all inserts
        cur.execute("CREATE INDEX idx_entries_word_norm ON entries(word_norm);")
        # speed up row lookup by (sheet,row_index)
        cur.execute("CREATE INDEX idx_entries_sheet_row ON entries(sheet, row_index);")

        con.commit()

        # mark loaded
        app.config["DATA_LOADED"] = True
        global current_excel_file
        current_excel_file = file_path
    finally:
        con.close()

 


def _loader_worker(file_path: str):
    global loading_thread, loading_cancelled
    try:
        loading_progress.update({
            "running": True,
            "file": os.path.basename(file_path),
            "current_sheet": None,
            "processed_words": 0,
            "total_words": compute_total_rows(file_path),
            "percent": 0.0,
            "error": None,
        })
        loading_cancelled = False
        _rebuild_sqlite_from_excel(file_path)
    except Exception as exc:
        loading_progress["error"] = str(exc)
    finally:
        loading_progress["running"] = False
        loading_thread = None


def list_txt_files() -> List[str]:
    files: List[str] = []
    if not os.path.isdir(DATA_DIR):
        return files
    for name in os.listdir(DATA_DIR):
        path = os.path.join(DATA_DIR, name)
        if os.path.isfile(path):
            _, ext = os.path.splitext(name)
            if ext.lower() in TXT_EXTENSIONS:
                files.append(name)
    # Sort by natural order when possible
    files.sort(key=lambda s: [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)])
    return files


# -----------------------------
# Routes
# -----------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/txt/list")
def api_txt_list():
    return jsonify({"files": list_txt_files()})


@app.route("/api/txt/content")
def api_txt_content():
    name = request.args.get("name", "").strip()
    if not name:
        return jsonify({"error": "missing name"}), 400
    # Security: only allow files from base dir and with .txt
    safe_name = os.path.basename(name)
    _, ext = os.path.splitext(safe_name)
    if ext.lower() not in TXT_EXTENSIONS:
        return jsonify({"error": "invalid file type"}), 400
    base = DATA_DIR if os.path.isdir(DATA_DIR) else BASE_DIR
    file_path = os.path.join(base, safe_name)
    if not os.path.exists(file_path):
        return jsonify({"error": "file not found"}), 404
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return jsonify({"name": safe_name, "content": content})
    except UnicodeDecodeError:
        with open(file_path, "r", encoding="gb18030", errors="ignore") as f:
            content = f.read()
        return jsonify({"name": safe_name, "content": content})


@app.route("/api/excel/files")
def api_excel_files():
    return jsonify({"files": list_excel_files()})


@app.route("/api/excel/status")
def api_excel_status():
    # 简化：仅以数据库是否存在且包含 entries 表为准
    actual_ready = False
    try:
        if os.path.exists(SQLITE_DB_PATH):
            con = sqlite3.connect(SQLITE_DB_PATH)
            cur = con.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
            actual_ready = cur.fetchone() is not None
            con.close()
    except Exception:
        actual_ready = False
    return jsonify({
        "loaded": bool(actual_ready),
        "running": bool(loading_progress.get("running")),
        "file": loading_progress.get("file"),
        "current_file": current_excel_file,
        "current_sheet": loading_progress.get("current_sheet"),
        "processed_words": loading_progress.get("processed_words", 0),
        "total_words": loading_progress.get("total_words", 0),
        "percent": loading_progress.get("percent", 0.0),
        "error": loading_progress.get("error"),
        "latest_words": loading_progress.get("latest_words", []),
    })


@app.route("/api/excel/stream")
def api_excel_stream():
    def generate():
        last = {
            "processed": -1,
            "latest_len": -1,
            "running": None,
            "loaded": None,
            "percent": -1,
        }
        while True:
            state = {
                "loaded": bool(app.config.get("DATA_LOADED", False)),
                "running": bool(loading_progress.get("running")),
                "file": loading_progress.get("file"),
                "current_sheet": loading_progress.get("current_sheet"),
                "processed_words": loading_progress.get("processed_words", 0),
                "total_words": loading_progress.get("total_words", 0),
                "percent": loading_progress.get("percent", 0.0),
                "error": loading_progress.get("error"),
                "latest_words": (loading_progress.get("latest_words", []) or [])[-40:],
            }
            changed = (
                state["processed_words"] != last["processed"]
                or len(state["latest_words"]) != last["latest_len"]
                or state["running"] != last["running"]
                or state["loaded"] != last["loaded"]
                or int(state["percent"]) != int(last["percent"])
            )
            if changed:
                last["processed"] = state["processed_words"]
                last["latest_len"] = len(state["latest_words"])
                last["running"] = state["running"]
                last["loaded"] = state["loaded"]
                last["percent"] = state["percent"]
                yield f"data: {json.dumps(state, ensure_ascii=False)}\n\n"
            time.sleep(0.2)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return Response(stream_with_context(generate()), mimetype="text/event-stream", headers=headers)


@app.route("/api/excel/load", methods=["POST"])
def api_excel_load():
    global loading_thread, current_excel_file
    file_name = request.args.get("file", "").strip()
    files = list_excel_files()
    allowed = {f["name"] for f in files}
    if not file_name or file_name not in allowed:
        return jsonify({"error": "invalid file"}), 400
    if loading_progress.get("running"):
        return jsonify({"error": "loading in progress"}), 409
    # reset state
    app.config["DATA_LOADED"] = False
    current_excel_file = None
    # remove existing sqlite db if any (fresh rebuild as requested)
    try:
        if os.path.exists(SQLITE_DB_PATH):
            os.remove(SQLITE_DB_PATH)
    except Exception:
        pass
    # clear legacy in-memory structures (no longer used)
    # start thread
    file_path = os.path.join(BASE_DIR, file_name)
    t = threading.Thread(target=_loader_worker, args=(file_path,), daemon=True)
    loading_thread = t
    t.start()
    return jsonify({"started": True})


@app.route("/api/excel/unload", methods=["POST"])
def api_excel_unload():
    global current_excel_file
    app.config["DATA_LOADED"] = False
    current_excel_file = None
    # clear legacy in-memory structures (no longer used)
    # delete sqlite db file as well
    try:
        if os.path.exists(SQLITE_DB_PATH):
            os.remove(SQLITE_DB_PATH)
    except Exception:
        pass
    return jsonify({"ok": True})


@app.route("/api/ai/chat", methods=["POST"])
def api_ai_chat():
    try:
        data = request.get_json(silent=True) or {}
        api_key = (data.get("api_key") or "").strip()
        content = (data.get("content") or "").strip()
        model = (data.get("model") or "Qwen/QwQ-32B").strip()
        system = (data.get("system") or "").strip()
        if not api_key:
            return jsonify({"error": "missing api_key"}), 400
        if not content:
            return jsonify({"error": "missing content"}), 400
        url = "https://api.siliconflow.cn/v1/chat/completions"
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})
        payload = {
            "model": model,
            "messages": messages,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        r = requests.post(url, json=payload, headers=headers, timeout=60)
        r.raise_for_status()
        dj = r.json()
        # extract first choice content safely
        msg = None
        try:
            msg = dj.get("choices", [{}])[0].get("message", {}).get("content", None)
        except Exception:
            msg = None
        # remove leading newlines often returned by some models
        if msg is None:
            cleaned = ""
        else:
            cleaned = str(msg).lstrip("\r\n")
        return jsonify({
            "message": cleaned,
            "raw": dj,
        })
    except requests.HTTPError as http_err:
        return jsonify({"error": f"http {http_err.response.status_code}", "detail": http_err.response.text}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

@app.route("/api/excel/search")
def api_excel_search():
    if not app.config.get("DATA_LOADED", False):
        return jsonify({"error": "loading or db not ready"}), 400
    word = request.args.get("word", "").strip()
    if not word:
        return jsonify({"error": "missing word"}), 400
    norm = normalize_word(word)
    try:
        con = sqlite3.connect(SQLITE_DB_PATH)
        cur = con.cursor()
        cur.execute(
            "SELECT sheet, row_index FROM entries WHERE word_norm = ? LIMIT 1",
            (norm,),
        )
        rows = cur.fetchall()
        matches: List[Dict[str, Any]] = []
        for s, r in rows:
            matches.append({"sheet": s, "row_index": int(r) if r is not None else 0})
        con.close()
        return jsonify({"word": word, "normalized": norm, "count": len(matches), "matches": matches})
    except Exception as exc:
        return jsonify({"error": f"db error: {exc}"}), 500


@app.route("/api/excel/row")
def api_excel_row():
    if not app.config.get("DATA_LOADED", False):
        return jsonify({"error": "loading or db not ready"}), 400
    sheet = request.args.get("sheet", "").strip()
    try:
        row_index = int(request.args.get("row_index", "-1"))
    except ValueError:
        row_index = -1
    if not sheet or row_index < 0:
        return jsonify({"error": "missing sheet or row_index"}), 400
    try:
        con = sqlite3.connect(SQLITE_DB_PATH)
        cur = con.cursor()
        cur.execute(
            "SELECT word, phonetic, meaning FROM entries WHERE sheet = ? AND row_index = ?",
            (sheet, row_index),
        )
        r = cur.fetchone()
        con.close()
        if not r:
            return jsonify({"error": "not found"}), 404
        word_text, phonetic, meaning = r
        # keep frontend compatibility using keys '1','2','3'
        row_obj = {
            "1": word_text or "",
            "2": phonetic or "",
            "3": meaning or "",
        }
        return jsonify({
            "sheet": sheet,
            "row_index": row_index,
            "row": row_obj,
        })
    except Exception as exc:
        return jsonify({"error": f"db error: {exc}"}), 500


# No auto-loading. Data is loaded via /api/excel/load
pass


if __name__ == "__main__":
    # Auto-detect existing SQLite database on startup
    try:
        db_ready = False
        if os.path.exists(SQLITE_DB_PATH):
            con = sqlite3.connect(SQLITE_DB_PATH)
            cur = con.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'")
            exists = cur.fetchone() is not None
            con.close()
            if exists:
                app.config["DATA_LOADED"] = True
                db_ready = True
                # Best-effort set current excel file for UI display
                data_xlsx_path = os.path.join(BASE_DIR, "data.xlsx")
                if os.path.exists(data_xlsx_path):
                    current_excel_file = data_xlsx_path
        # If DB not ready, try to auto-load once on startup
        if not db_ready:
            excel_candidates = [
                name for name in os.listdir(BASE_DIR)
                if os.path.isfile(os.path.join(BASE_DIR, name))
                and os.path.splitext(name)[1].lower() in EXCEL_EXTENSIONS
            ]
            excel_candidates.sort()
            auto_excel = excel_candidates[0] if excel_candidates else None
            if auto_excel:
                auto_excel_path = os.path.join(BASE_DIR, auto_excel)
                is_main_worker = (os.environ.get("WERKZEUG_RUN_MAIN") == "true") or not bool(os.environ.get("WERKZEUG_RUN_MAIN"))
                if os.path.exists(auto_excel_path) and is_main_worker and not loading_progress.get("running"):
                    app.config["DATA_LOADED"] = False
                    try:
                        if os.path.exists(SQLITE_DB_PATH):
                            os.remove(SQLITE_DB_PATH)
                    except Exception:
                        pass
                    t = threading.Thread(target=_loader_worker, args=(auto_excel_path,), daemon=True)
                    loading_thread = t
                    t.start()
    except Exception:
        pass
    app.run(host="0.0.0.0", port=5000, debug=True)


