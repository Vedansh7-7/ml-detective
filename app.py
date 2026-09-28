"""
ML Detective -- a local, single-player Jupyter-like game.

You get a dataset + its public metadata and must find the ONE planted
fault/feature hidden in it, using your own pandas/numpy/sklearn code
typed into notebook-style cells. Submit your guess; right answer wins
(time + steps recorded), wrong answer earns you a progressively more
specific hint.

Everything runs locally: no accounts, no network calls, no external
services. The "secret" files under secrets/ are never sent to the
browser -- only app.py reads them.

SECURITY NOTE: /api/run executes the code you type with plain `exec()`,
the same trust model as a local Jupyter kernel. This is intentional --
it's your own machine and your own code. Do not expose this server to
the internet or to untrusted users.

LAN MODE (`python app.py --lan`): friends on the same Wi-Fi can play too.
Each browser gets its own game; a join code printed at startup gates
the API. Their code still runs on THIS machine as YOU, so only hand the
code to people you'd let sit at your keyboard.
"""
import ast
import base64
import io
import json
import linecache
import os
import re
import secrets
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout

import matplotlib
matplotlib.use("Agg")  # headless backend, must be set before pyplot import
import matplotlib.pyplot as plt
import pandas as pd
from flask import Flask, jsonify, request, send_from_directory

from story_ingest import ingest_inbox

HERE = os.path.dirname(os.path.abspath(__file__))
DATASETS_DIR = os.path.join(HERE, "datasets")
SECRETS_DIR = os.path.join(HERE, "secrets")
RESULTS_FILE = os.path.join(HERE, "results", "leaderboard.json")
FEEDBACK_FILE = os.path.join(HERE, "results", "feedback.json")
STATIC_DIR = os.path.join(HERE, "static")

app = Flask(__name__, static_folder=None)

LEVEL_ORDER = ["easy", "normal", "hard"]


def discover_stories():
    """Every datasets/<id>.story.json that also has its .csv, .meta.json
    and a secret is a playable story. Dropping in a new set of files is
    all it takes to add one -- no code change here.

    Returns {level: [story_id, ...]} in LEVEL_ORDER."""
    levels = {lvl: [] for lvl in LEVEL_ORDER}
    for name in sorted(os.listdir(DATASETS_DIR)):
        if not name.endswith(".story.json"):
            continue
        story_id = name[: -len(".story.json")]
        needed = [
            os.path.join(DATASETS_DIR, f"{story_id}.csv"),
            os.path.join(DATASETS_DIR, f"{story_id}.meta.json"),
            os.path.join(SECRETS_DIR, f"{story_id}.json"),
        ]
        if not all(os.path.exists(p) for p in needed):
            continue
        level = load_story(story_id).get("level")
        if level in levels:
            levels[level].append(story_id)
    return levels

# Just a hint for the sidebar -- the kernel doesn't restrict imports to
# this list, it's every package actually pip-installed in .venv.
AVAILABLE_PACKAGES = ["pandas", "numpy", "matplotlib", "seaborn", "scikit-learn", "scipy"]

PLAYER_COOKIE = "mld_player"
KEY_COOKIE = "mld_key"

# Set by --lan at startup. None = localhost-only mode, no join code needed.
JOIN_CODE = None

# One in-memory game per browser, keyed by the PLAYER_COOKIE id.
PLAYERS = {}          # player id -> {"name": str, "game": {...}}
PLAYERS_LOCK = threading.Lock()

# redirect_stdout swaps sys.stdout for the whole process and pyplot keeps
# one global figure list, so two cells running at once would steal each
# other's output. Cells run one at a time, across all players.
RUN_LOCK = threading.Lock()
FILE_LOCK = threading.Lock()


def new_game():
    return {
        "dataset_id": None,
        "level": None,
        "exec_globals": None,
        "start_time": None,
        "steps": 0,
        "attempts": 0,
        "solved": False,
    }


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def load_meta(dataset_id):
    with open(os.path.join(DATASETS_DIR, f"{dataset_id}.meta.json")) as f:
        return json.load(f)


def load_story(dataset_id):
    with open(os.path.join(DATASETS_DIR, f"{dataset_id}.story.json")) as f:
        return json.load(f)


def load_secret(dataset_id):
    with open(os.path.join(SECRETS_DIR, f"{dataset_id}.json")) as f:
        return json.load(f)


def fresh_exec_globals(df):
    """A blank kernel namespace, like a fresh Jupyter/Kaggle notebook: only
    the dataset itself is preloaded as `df`. The player imports whatever
    they want (pandas, numpy, matplotlib, sklearn, scipy, seaborn... are
    all installed) under whatever alias they like -- nothing is forced on
    them. Persists across /api/run calls for the current level, so an
    import in one cell is still available in the next, same as a real
    kernel.
    """
    return {
        "__builtins__": __builtins__,
        "df": df,
    }


def format_value(val):
    """Render a cell's trailing expression roughly like Jupyter would."""
    if val is None:
        return None
    if isinstance(val, (pd.DataFrame, pd.Series)):
        try:
            return {"html": val.to_frame().to_html(max_rows=60)
                     if isinstance(val, pd.Series) else val.to_html(max_rows=60)}
        except Exception:
            return {"text": repr(val)}
    return {"text": repr(val)}


def run_code(code, glbls, cell_name="<cell>"):
    """Exec a notebook cell, auto-printing a trailing bare expression,
    and capturing stdout + any matplotlib figures it produced."""
    stdout = io.StringIO()
    result = None
    error = None
    images = []
    # register the source so tracebacks can quote the offending line,
    # like Jupyter does (linecache is where traceback looks for source)
    linecache.cache[cell_name] = (len(code), None, code.splitlines(True), cell_name)
    try:
        tree = ast.parse(code, filename=cell_name, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop()
        exec_code = compile(tree, cell_name, "exec")
        eval_code = (compile(ast.Expression(last_expr.value), cell_name, "eval")
                     if last_expr is not None else None)

        with redirect_stdout(stdout), redirect_stderr(stdout):
            exec(exec_code, glbls)
            if eval_code is not None:
                val = eval(eval_code, glbls)
                result = format_value(val)

        for num in plt.get_fignums():
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
        plt.close("all")
    except Exception as exc:
        # drop the frames that belong to this server, keep the player's
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != cell_name:
            tb = tb.tb_next
        error = "".join(traceback.format_exception(type(exc), exc, tb))
        plt.close("all")

    return {
        "stdout": stdout.getvalue(),
        "result": result,
        "images": images,
        "error": error,
    }


_STOPWORDS = {
    "the", "a", "an", "column", "columns", "field", "value", "values",
    "is", "are", "in", "of", "there", "has", "have", "problem", "issue",
    "hidden", "fault", "feature", "data", "row", "rows",
}


def _normalize_tokens(text):
    """lowercase, treat '_' like a space, strip punctuation, drop filler
    words -- so 'the Age column' and 'age_outliers' both reduce to a
    comparable bag of meaningful tokens."""
    text = text.lower().replace("_", " ")
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return {t for t in text.split() if t and t not in _STOPWORDS}


def check_answer(user_text, secret):
    """
    Decide whether the player's free-text guess correctly names the
    hidden fault for this dataset.

    Strategy: normalize both sides into a bag of meaningful tokens (case
    folded, punctuation/underscores stripped, filler words like "the"/
    "column" removed), then accept if the guess contains EVERY token of
    at least one accepted answer (or of the target column name). So
    "age" and "the age column has outliers" both match "age", but a
    lone generic word like "outliers" doesn't match "age outliers" --
    the guess has to name the thing, not just the kind of problem.
    """
    user_tokens = _normalize_tokens(user_text)
    if not user_tokens:
        return False

    candidates = list(secret.get("accepted_answers", []))
    target_column = secret.get("target_column")
    if target_column:
        candidates.append(target_column)

    for candidate in candidates:
        cand_tokens = _normalize_tokens(candidate)
        if not cand_tokens:
            continue
        if cand_tokens.issubset(user_tokens):
            return True
    return False


def _load_list(path):
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _append(path, entry):
    with FILE_LOCK:
        items = _load_list(path)
        items.append(entry)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(items, f, indent=2, ensure_ascii=False)


def load_results():
    return _load_list(RESULTS_FILE)


def save_result(entry):
    _append(RESULTS_FILE, entry)


# ---------------------------------------------------------------------------
# players + join code
# ---------------------------------------------------------------------------
def is_host():
    return request.remote_addr in ("127.0.0.1", "::1")


def current_player():
    """The player record for this browser, or None if it hasn't joined."""
    pid = request.cookies.get(PLAYER_COOKIE)
    with PLAYERS_LOCK:
        return PLAYERS.get(pid)


def clean_name(name):
    name = re.sub(r"\s+", " ", (name or "")).strip()
    return name[:24]


@app.before_request
def require_join_code():
    """In LAN mode every API call except config/join needs the join code
    (the host's own browser on 127.0.0.1 is let through)."""
    if JOIN_CODE is None or is_host():
        return None
    if not request.path.startswith("/api/") or request.path in ("/api/config", "/api/join"):
        return None
    if request.cookies.get(KEY_COOKIE) != JOIN_CODE:
        return jsonify({"error": "join code required -- reload the page and enter it"}), 403
    return None


@app.after_request
def mark_seen(resp):
    """Presence for the live board's 'detectives online' counter."""
    if request.path.startswith("/api/"):
        player = current_player()
        if player is not None:
            player["last_seen"] = time.time()
    return resp


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:path>")
def static_files(path):
    return send_from_directory(STATIC_DIR, path)


@app.route("/api/levels")
def api_levels():
    """Everything the hero page needs to list stories: public story +
    public meta per story, grouped by level. Never includes secrets.

    Also files any story packs waiting in stories_inbox/ first, so a new
    pack shows up just by reloading the archive."""
    inbox = []
    for r in ingest_inbox():
        # rejection reasons can quote the secret (e.g. the target column),
        # so the browser only learns *that* a pack failed and where to look
        if r["ok"]:
            inbox.append({"ok": True, "title": r["title"], "level": r["level"]})
        else:
            inbox.append({"ok": False, "file": r["file"], "problems": len(r["errors"])})

    # a list, not a dict: jsonify sorts dict keys, which would put
    # "hard" before "normal"
    return jsonify({
        "inbox": inbox,
        "levels": [
            {"level": level,
             "stories": [{"story": load_story(d), "meta": load_meta(d)} for d in ids]}
            for level, ids in discover_stories().items()
        ],
    })


@app.route("/api/config")
def api_config():
    player = current_player()
    return jsonify({
        "lan": JOIN_CODE is not None,
        "needs_code": JOIN_CODE is not None and not is_host()
                      and request.cookies.get(KEY_COOKIE) != JOIN_CODE,
        "name": player["name"] if player else None,
    })


@app.route("/api/join", methods=["POST"])
def api_join():
    body = request.get_json(force=True)
    name = clean_name(body.get("name"))
    if not name:
        return jsonify({"error": "pick a detective name first"}), 400
    code = (body.get("code") or "").strip().upper()
    if JOIN_CODE is not None and not is_host() and code != JOIN_CODE:
        if request.cookies.get(KEY_COOKIE) != JOIN_CODE:
            return jsonify({"error": "wrong join code -- ask the host"}), 403
        code = JOIN_CODE

    pid = request.cookies.get(PLAYER_COOKIE)
    with PLAYERS_LOCK:
        if pid not in PLAYERS:
            pid = secrets.token_urlsafe(16)
            PLAYERS[pid] = {"name": name, "game": new_game(), "last_seen": time.time()}
        else:
            PLAYERS[pid]["name"] = name

    resp = jsonify({"ok": True, "name": name})
    week = 7 * 24 * 3600
    resp.set_cookie(PLAYER_COOKIE, pid, max_age=week, httponly=True, samesite="Strict")
    if JOIN_CODE is not None and code == JOIN_CODE:
        resp.set_cookie(KEY_COOKIE, JOIN_CODE, max_age=week, httponly=True, samesite="Strict")
    return resp


def player_or_error():
    player = current_player()
    if player is None:
        return None, (jsonify({"error": "you're not signed in -- reload the page"}), 401)
    return player, None


@app.route("/api/start", methods=["POST"])
def api_start():
    player, err = player_or_error()
    if err:
        return err
    body = request.get_json(force=True)
    dataset_id = body.get("story_id")
    level = next((lvl for lvl, ids in discover_stories().items() if dataset_id in ids), None)
    if level is None:
        return jsonify({"error": f"unknown story '{dataset_id}'"}), 400

    df = pd.read_csv(os.path.join(DATASETS_DIR, f"{dataset_id}.csv"))
    meta = load_meta(dataset_id)

    player["game"] = new_game()
    player["game"].update({
        "dataset_id": dataset_id,
        "level": level,
        "exec_globals": fresh_exec_globals(df),
        "start_time": time.time(),
        "steps": 0,
        "attempts": 0,
        "solved": False,
    })

    return jsonify({
        "meta": meta,
        "story": load_story(dataset_id),
        "preview_html": df.head(8).to_html(max_rows=8),
        "shape": list(df.shape),
        "available_packages": AVAILABLE_PACKAGES,
    })


@app.route("/api/run", methods=["POST"])
def api_run():
    player, err = player_or_error()
    if err:
        return err
    GAME = player["game"]
    if GAME["exec_globals"] is None:
        return jsonify({"error": "no active game -- call /api/start first"}), 400
    body = request.get_json(force=True)
    code = body.get("code", "")
    with RUN_LOCK:
        GAME["steps"] += 1
        output = run_code(code, GAME["exec_globals"], cell_name=f"<cell {GAME['steps']}>")
    output["steps"] = GAME["steps"]
    return jsonify(output)


@app.route("/api/submit", methods=["POST"])
def api_submit():
    player, err = player_or_error()
    if err:
        return err
    GAME = player["game"]
    if GAME["dataset_id"] is None:
        return jsonify({"error": "no active game -- call /api/start first"}), 400
    if GAME["solved"]:
        return jsonify({"error": "already solved -- start a new level"}), 400

    body = request.get_json(force=True)
    answer = (body.get("answer") or "").strip()
    secret = load_secret(GAME["dataset_id"])

    correct = check_answer(answer, secret)

    if correct:
        GAME["solved"] = True
        elapsed = round(time.time() - GAME["start_time"], 1)
        entry = {
            "player": player["name"],
            "level": GAME["level"],
            "dataset_id": GAME["dataset_id"],
            "story_title": load_story(GAME["dataset_id"]).get("title"),
            "elapsed_seconds": elapsed,
            "steps": GAME["steps"],
            "attempts": GAME["attempts"] + 1,
            "timestamp": time.time(),
        }
        save_result(entry)
        return jsonify({
            "correct": True,
            "elapsed_seconds": elapsed,
            "steps": GAME["steps"],
            "attempts": entry["attempts"],
            "explanation": secret["description"],
        })

    GAME["attempts"] += 1
    hints = secret["hints"]
    hint_idx = min(GAME["attempts"] - 1, len(hints) - 1)
    return jsonify({
        "correct": False,
        "attempts": GAME["attempts"],
        "hint": hints[hint_idx],
    })


@app.route("/api/leaderboard")
def api_leaderboard():
    return jsonify(load_results())


ONLINE_WINDOW_SECONDS = 20  # every open tab polls /api/live every few seconds


@app.route("/api/live")
def api_live():
    """Polled by every open tab: the leaderboard plus who's around."""
    now = time.time()
    with PLAYERS_LOCK:
        online = sum(1 for p in PLAYERS.values()
                     if now - p.get("last_seen", 0) < ONLINE_WINDOW_SECONDS)
    return jsonify({"online": online, "results": load_results(), "now": now})


@app.route("/api/feedback", methods=["POST"])
def api_feedback():
    player, err = player_or_error()
    if err:
        return err
    body = request.get_json(force=True)
    text = (body.get("text") or "").strip()[:4000]
    rating = body.get("rating")
    if not text and rating is None:
        return jsonify({"error": "write something first"}), 400
    if rating is not None:
        try:
            rating = max(1, min(5, int(rating)))
        except (TypeError, ValueError):
            rating = None
    _append(FEEDBACK_FILE, {
        "player": player["name"],
        "rating": rating,
        "text": text,
        "case": player["game"]["dataset_id"],
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    return jsonify({"ok": True})


def lan_addresses():
    """Best-effort list of this machine's IPv4 addresses on the LAN."""
    import socket
    addrs = set()
    try:
        # UDP "connect" sends nothing; it just picks the outgoing interface
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            addrs.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            addrs.add(info[4][0])
    except OSError:
        pass
    return sorted(a for a in addrs if not a.startswith("127."))


if __name__ == "__main__":
    import sys
    import webbrowser

    port = 5057
    url = f"http://127.0.0.1:{port}"
    lan = "--lan" in sys.argv
    if lan:
        # short, unambiguous (no 0/O/1/I) code friends type once
        JOIN_CODE = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
        print("\n  ML DETECTIVE -- LAN mode")
        print("  Friends on the same Wi-Fi open:")
        for a in lan_addresses() or ["<your-ip>"]:
            print(f"      http://{a}:{port}")
        print(f"  Join code: {JOIN_CODE}")
        print("  Their code runs on THIS PC as you -- share the code only with people you trust.\n")
    if "--open" in sys.argv:
        # the heavy imports are done by now, so the server binds almost
        # immediately; a short delay covers the rest
        threading.Timer(1.0, webbrowser.open, args=[url]).start()
    # Default is 127.0.0.1 only: this server runs code with exec(). --lan
    # opens it to the local network (never port-forward it to the internet).
    app.run(host="0.0.0.0" if lan else "127.0.0.1", port=port, debug=False, threaded=True)
