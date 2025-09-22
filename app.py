import os
import re
import threading
import time
import json
from collections import OrderedDict
from datetime import datetime
from typing import Dict, List, Any, Optional, Tuple

from flask import Flask, jsonify, request, render_template, Response, stream_with_context
import pandas as pd


app = Flask(__name__, static_folder="static", template_folder="templates")
app.config["DATA_LOADED"] = False


# -----------------------------
# Config
# -----------------------------
BASE_DIR = os.path.abspath(os.getcwd())
TXT_EXTENSIONS = {".txt"}
EXCEL_EXTENSIONS = {".xlsx", ".xls"}
DATA_DIR = os.path.join(BASE_DIR, "data")


# -----------------------------
# Excel in-memory store
# -----------------------------
current_excel_file: Optional[str] = None
word_index: Dict[str, List[Dict[str, Any]]]= {}
# Preloaded row store: sheet -> row_index -> { '0': '...', '1': '...', '2': '...', '3': '...' }
row_store: Dict[str, Dict[int, Dict[str, Optional[str]]]] = {}

# Sheet cache for on-demand row fetching (LRU)
SHEET_CACHE_CAPACITY = 5
sheet_cache: "OrderedDict[str, pd.DataFrame]" = OrderedDict()

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


def _sheet_cache_get(sheet: str) -> Optional[pd.DataFrame]:
    if sheet in sheet_cache:
        df = sheet_cache.pop(sheet)
        sheet_cache[sheet] = df
        return df
    return None


def _sheet_cache_put(sheet: str, df: pd.DataFrame) -> None:
    sheet_cache[sheet] = df
    if len(sheet_cache) > SHEET_CACHE_CAPACITY:
        sheet_cache.popitem(last=False)


def get_sheet_df(sheet: str) -> Optional[pd.DataFrame]:
    global current_excel_file
    if not current_excel_file:
        return None
    df = _sheet_cache_get(sheet)
    if df is not None:
        return df
    try:
        df = pd.read_excel(current_excel_file, sheet_name=sheet, header=None, dtype=str)
        df.columns = [str(col) for col in range(df.shape[1])]
        _sheet_cache_put(sheet, df)
        return df
    except Exception:
        return None


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


def _build_index_from_file(file_path: str) -> None:
    global current_excel_file, word_index, sheet_cache, loading_cancelled, row_store
    word_index.clear()
    sheet_cache.clear()
    row_store.clear()
    loading_progress["latest_words"] = []

    # sampling config for recent word preview
    SAMPLE_STEP = 10  # record every 10th word to reduce overhead
    LATEST_LIMIT = 40 # keep last 40 items

    xls = pd.ExcelFile(file_path)
    sheets = xls.sheet_names
    for sheet in sheets:
        if loading_cancelled:
            return
        loading_progress["current_sheet"] = sheet
        try:
            df = xls.parse(sheet_name=sheet, header=None, dtype=str)
            num_cols = df.shape[1]
            word_col_idx = 1 if num_cols > 1 else 0
            # store limited columns per row (0..3)
            df.columns = [str(col) for col in range(num_cols)]
            cols_to_store = [str(i) for i in range(min(4, num_cols))]
            sheet_rows: Dict[int, Dict[str, Optional[str]]] = {}
            # iterate words in column
            for row_idx, value in enumerate(df.iloc[:, word_col_idx].fillna("")):
                if loading_cancelled:
                    return
                display_word = str(value).strip()
                norm = normalize_word(value)
                loading_progress["processed_words"] += 1
                # sample recent words
                if loading_progress["processed_words"] % SAMPLE_STEP == 0 and display_word:
                    lw = loading_progress.get("latest_words", [])
                    lw.append(display_word)
                    if len(lw) > LATEST_LIMIT:
                        del lw[: len(lw) - LATEST_LIMIT]
                    loading_progress["latest_words"] = lw
                if not norm:
                    # still store row data even if no index word
                    pass
                else:
                    word_index.setdefault(norm, []).append({
                        "sheet": sheet,
                        "row_index": int(row_idx),
                    })
                # build minimal row data
                row_series = df.iloc[row_idx]
                row_dict: Dict[str, Optional[str]] = {}
                for c in cols_to_store:
                    val = row_series.get(c, None)
                    if pd.isna(val):
                        row_dict[c] = None
                    else:
                        row_dict[c] = str(val)
                sheet_rows[int(row_idx)] = row_dict
            row_store[sheet] = sheet_rows
            # optionally cache small sheets
        except Exception as exc:
            loading_progress["error"] = f"sheet '{sheet}' failed: {exc}"
        # update percent after each sheet
        total = loading_progress.get("total_words", 0) or 0
        processed = loading_progress.get("processed_words", 0)
        loading_progress["percent"] = (processed / total * 100.0) if total > 0 else 0.0

    current_excel_file = file_path
    app.config["DATA_LOADED"] = True


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
        _build_index_from_file(file_path)
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
    return jsonify({
        "loaded": bool(app.config.get("DATA_LOADED", False)),
        "running": bool(loading_progress.get("running")),
        "file": loading_progress.get("file"),
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
    word_index.clear()
    sheet_cache.clear()
    row_store.clear()
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
    word_index.clear()
    sheet_cache.clear()
    row_store.clear()
    return jsonify({"ok": True})


@app.route("/api/excel/search")
def api_excel_search():
    if not app.config.get("DATA_LOADED", False):
        return jsonify({"error": "excel not loaded"}), 400
    word = request.args.get("word", "").strip()
    if not word:
        return jsonify({"error": "missing word"}), 400
    norm = normalize_word(word)
    matches = word_index.get(norm, [])
    return jsonify({"word": word, "normalized": norm, "count": len(matches), "matches": matches})


@app.route("/api/excel/row")
def api_excel_row():
    if not app.config.get("DATA_LOADED", False):
        return jsonify({"error": "excel not loaded"}), 400
    sheet = request.args.get("sheet", "").strip()
    try:
        row_index = int(request.args.get("row_index", "-1"))
    except ValueError:
        row_index = -1
    if not sheet or row_index < 0:
        return jsonify({"error": "missing sheet or row_index"}), 400
    sheet_rows = row_store.get(sheet)
    if not sheet_rows or row_index not in sheet_rows:
        return jsonify({"error": "not found"}), 404
    row = sheet_rows[row_index]
    return jsonify({
        "sheet": sheet,
        "row_index": row_index,
        "row": row
    })


# No auto-loading. Data is loaded via /api/excel/load
pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)


