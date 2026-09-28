"""
Story-pack ingester.

Drop a story pack (the JSON an AI writes from STORY_PROMPT.md) into
stories_inbox/ and it is filed as a playable case the next time the
archive loads -- or run this file directly to ingest right away:

    .venv\\Scripts\\python.exe story_ingest.py

For each pack in stories_inbox/ (*.json, *.txt or *.md):
  1. parse it (tolerates ```json fences and chatter around the JSON)
  2. validate the schema, colour contrast, doodle SVG and spoilers
  3. statically screen the pack's Python for file/network/system access
  4. run generate(rng) and check(df) in a separate, time-limited process,
     then run check(df) again on the saved CSV (what the player loads)
  5. write datasets/<id>.csv/.meta.json/.story.json, secrets/<id>.json
     and static/doodles/<id>.svg
  6. move the pack to stories_inbox/processed/, or to
     stories_inbox/failed/ with a <name>.error.txt explaining why

SAFETY NOTE: step 3 is a screen, not a sandbox. It blocks the obvious
ways code can touch files, the network or the OS, and step 4 runs in a
separate process with a timeout, but determined code could still get
around it. Only ingest packs from AIs/people you trust.
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
INBOX = os.path.join(HERE, "stories_inbox")
PROCESSED = os.path.join(INBOX, "processed")
FAILED = os.path.join(INBOX, "failed")
DATASETS_DIR = os.path.join(HERE, "datasets")
SECRETS_DIR = os.path.join(HERE, "secrets")
DOODLES_DIR = os.path.join(HERE, "static", "doodles")

LEVELS = ("easy", "normal", "hard")
PACK_EXTENSIONS = (".json", ".txt", ".md")
PALETTE_KEYS = ("bg", "surface", "ink", "muted", "accent", "accent2", "note", "note_ink")
RUN_TIMEOUT_SECONDS = 60
MIN_ROWS, MAX_ROWS = 100, 20000
MIN_COLS, MAX_COLS = 3, 30

_lock = threading.Lock()


# ---------------------------------------------------------------------------
# parsing
# ---------------------------------------------------------------------------
def parse_pack(text):
    """The JSON object in `text`, even if an AI wrapped it in a code
    fence or put a sentence before/after it."""
    text = text.lstrip("﻿")
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in the file")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise ValueError(f"the JSON is malformed: {e}") from None


def _joined(value):
    """Code and SVG may be given as one string or a list of lines."""
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return "\n".join(value)
    return value


# ---------------------------------------------------------------------------
# validation helpers
# ---------------------------------------------------------------------------
def _hex_to_rgb(h):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5))


def _luminance(h):
    def channel(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (channel(c) for c in _hex_to_rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


# (foreground, background, minimum ratio, why it matters)
CONTRAST_RULES = [
    ("ink", "bg", 4.5, "main text on the page"),
    ("ink", "surface", 4.5, "code in the notebook cells"),
    ("note_ink", "note", 4.5, "text on the sticky note"),
    ("muted", "bg", 3.0, "secondary text"),
    ("accent", "bg", 3.0, "buttons and the doodle"),
]

SVG_ALLOWED_TAGS = {"svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon"}
SVG_FORBIDDEN = [
    (r"<\s*script", "a <script> element"),
    (r"\bon[a-z]+\s*=", "an event-handler attribute (onload=, onclick=...)"),
    (r"javascript\s*:", "a javascript: URL"),
    (r"(href|src)\s*=", "a link or external reference (href/src)"),
    (r"<\s*(style|foreignObject|image|use|iframe|object|embed)\b", "a <style>/<foreignObject>/<image>/<use> element"),
    (r"url\s*\(", "a url(...) reference"),
]


def check_svg(svg):
    errors = []
    if not isinstance(svg, str) or not svg.strip().startswith("<svg"):
        return ["doodle_svg must be a string starting with <svg"]
    if len(svg) > 20000:
        errors.append(f"doodle_svg is {len(svg)} characters; keep it under 20000")
    for pattern, what in SVG_FORBIDDEN:
        if re.search(pattern, svg, re.IGNORECASE):
            errors.append(f"doodle_svg contains {what}, which is not allowed")
    tags = {t.lower() for t in re.findall(r"<\s*([a-zA-Z][\w:-]*)", svg)}
    bad = sorted(tags - SVG_ALLOWED_TAGS)
    if bad:
        errors.append(f"doodle_svg uses disallowed elements: {', '.join(bad)} "
                      f"(allowed: {', '.join(sorted(SVG_ALLOWED_TAGS))})")
    return errors


ALLOWED_IMPORTS = {"numpy", "pandas", "math", "random", "string", "datetime",
                   "itertools", "collections", "statistics", "functools"}
BANNED_NAMES = {"open", "exec", "eval", "compile", "__import__", "input", "globals",
                "locals", "vars", "getattr", "setattr", "delattr", "breakpoint",
                "exit", "quit", "help", "memoryview", "__builtins__"}
BANNED_ATTRS = {"load", "save", "savez", "savez_compressed", "savetxt", "loadtxt",
                "fromfile", "tofile", "genfromtxt", "memmap", "DataSource", "system",
                "popen", "remove", "unlink", "rmdir"}
ALLOWED_TO_ATTRS = {"to_numpy", "to_datetime", "to_timedelta", "to_numeric", "to_frame",
                    "to_list", "to_dict", "to_period", "to_timestamp", "to_string",
                    "to_records", "to_pydatetime", "to_offset"}


def check_code_safety(src):
    """Reject code that reaches for files, the network or the OS. This is
    a screen, not a sandbox -- see the module docstring."""
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        return [f"code has a syntax error on line {e.lineno}: {e.msg}"]

    errors = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            mods = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for mod in mods:
                if mod.split(".")[0] not in ALLOWED_IMPORTS:
                    errors.append(f"line {node.lineno}: import of '{mod}' is not allowed "
                                  f"(allowed: {', '.join(sorted(ALLOWED_IMPORTS))})")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            errors.append(f"line {node.lineno}: '{node.id}' is not allowed")
        elif isinstance(node, ast.Attribute):
            attr = node.attr
            if attr.startswith("__"):
                errors.append(f"line {node.lineno}: dunder attribute '.{attr}' is not allowed")
            elif attr in BANNED_ATTRS or attr.startswith("read_") or (
                    attr.startswith("to_") and attr not in ALLOWED_TO_ATTRS):
                errors.append(f"line {node.lineno}: '.{attr}' touches files or the OS and is not allowed")

    defined = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    for fn in ("generate", "check"):
        if fn not in defined:
            errors.append(f"code must define a top-level function {fn}()")
    return errors


def _word_in(word, text):
    return re.search(rf"(?<![a-z0-9]){re.escape(word)}(?![a-z0-9])", text) is not None


def check_spoilers(pack):
    """The story is shown before the player investigates, so it must not
    name the answer."""
    story = pack["story"]
    visible = " ".join([story["title"], story["hook"], *story["narrative"]]).lower()
    target = pack["secret"]["target_column"].lower()
    errors = []
    for form in {target, target.replace("_", " ")}:
        if _word_in(form, visible):
            errors.append(f"the story text names the target column '{target}' -- "
                          f"that gives the answer away before the player starts")
    return errors


# ---------------------------------------------------------------------------
# schema
# ---------------------------------------------------------------------------
def _need(obj, key, kind, path, errors):
    if not isinstance(obj, dict) or key not in obj:
        errors.append(f"missing '{path}{key}'")
        return None
    val = obj[key]
    if not isinstance(val, kind):
        names = kind.__name__ if isinstance(kind, type) else " or ".join(k.__name__ for k in kind)
        errors.append(f"'{path}{key}' must be {names}")
        return None
    return val


def validate_pack(pack):
    """Structural checks; returns a list of human-readable problems."""
    errors = []
    if not isinstance(pack, dict):
        return ["the pack must be a JSON object"]

    pid = _need(pack, "id", str, "", errors)
    if pid is not None:
        if not re.fullmatch(r"[a-z0-9_]{3,60}", pid):
            errors.append("'id' must be 3-60 characters of lowercase letters, digits and _")
        elif any(os.path.exists(p) for p in (
                os.path.join(DATASETS_DIR, f"{pid}.story.json"),
                os.path.join(DATASETS_DIR, f"{pid}.csv"),
                os.path.join(SECRETS_DIR, f"{pid}.json"))):
            errors.append(f"a case with id '{pid}' already exists -- pick a new id")

    level = _need(pack, "level", str, "", errors)
    if level is not None and level not in LEVELS:
        errors.append(f"'level' must be one of {', '.join(LEVELS)}")

    story = _need(pack, "story", dict, "", errors)
    if story is not None:
        _need(story, "title", str, "story.", errors)
        hook = _need(story, "hook", str, "story.", errors)
        if hook is not None and len(hook) > 140:
            errors.append("'story.hook' should be at most 140 characters")
        narrative = _need(story, "narrative", list, "story.", errors)
        if narrative is not None and not (
                2 <= len(narrative) <= 5 and all(isinstance(p, str) and p.strip() for p in narrative)):
            errors.append("'story.narrative' must be a list of 2-5 non-empty paragraphs")
        palette = _need(story, "palette", dict, "story.", errors)
        if palette is not None:
            for k in PALETTE_KEYS:
                v = palette.get(k)
                if not (isinstance(v, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", v)):
                    errors.append(f"'story.palette.{k}' must be a #rrggbb colour")

    meta = _need(pack, "meta", dict, "", errors)
    if meta is not None:
        _need(meta, "description", str, "meta.", errors)
        cols = _need(meta, "columns", dict, "meta.", errors)
        if cols is not None and not all(isinstance(v, str) for v in cols.values()):
            errors.append("'meta.columns' must map each column name to a description string")

    secret = _need(pack, "secret", dict, "", errors)
    if secret is not None:
        for key in ("fault_type", "target_column", "description"):
            _need(secret, key, str, "secret.", errors)
        answers = _need(secret, "accepted_answers", list, "secret.", errors)
        if answers is not None and not (
                len(answers) >= 3 and all(isinstance(a, str) and a.strip() for a in answers)):
            errors.append("'secret.accepted_answers' must list at least 3 phrasings")
        hints = _need(secret, "hints", list, "secret.", errors)
        if hints is not None and not (
                len(hints) == 3 and all(isinstance(h, str) and h.strip() for h in hints)):
            errors.append("'secret.hints' must be exactly 3 hints, vaguest first")

    data = _need(pack, "data", dict, "", errors)
    if data is not None:
        if not isinstance(data.get("seed"), int):
            errors.append("'data.seed' must be an integer")
        if not isinstance(_joined(data.get("code")), str):
            errors.append("'data.code' must be a string (or a list of lines)")

    if not isinstance(_joined(pack.get("doodle_svg")), str):
        errors.append("missing 'doodle_svg' (a string, or a list of lines)")
    return errors


# ---------------------------------------------------------------------------
# running the pack's generator
# ---------------------------------------------------------------------------
RUNNER = r'''
import json, sys, traceback
import numpy as np
import pandas as pd

code_path, out_csv, seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
ns = {"np": np, "pd": pd, "__name__": "pack"}
try:
    with open(code_path, encoding="utf-8") as f:
        src = f.read()
    exec(compile(src, "<pack code>", "exec"), ns)
    df = ns["generate"](np.random.default_rng(seed))
    if not isinstance(df, pd.DataFrame):
        raise TypeError("generate(rng) must return a pandas DataFrame, got " + type(df).__name__)
    if not bool(ns["check"](df.copy())):
        raise AssertionError("check(df) returned False on the generated data -- "
                             "generate() did not plant the fault check() looks for")
    df.to_csv(out_csv, index=False)
    reloaded = pd.read_csv(out_csv)
    if not bool(ns["check"](reloaded)):
        raise AssertionError("check(df) passes on the DataFrame but fails on the saved CSV. "
                             "The player loads the CSV, so the fault must survive a CSV "
                             "round-trip (dates become strings, categories become text, floats get rounded)")
    print(json.dumps({"ok": True, "rows": len(reloaded), "columns": list(reloaded.columns)}))
except Exception:
    print(json.dumps({"ok": False, "error": traceback.format_exc(limit=4)}))
'''


def run_generator(code, seed, out_csv):
    with tempfile.TemporaryDirectory() as tmp:
        code_path = os.path.join(tmp, "pack_code.py")
        with open(code_path, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-c", RUNNER, code_path, out_csv, str(seed)],
                cwd=tmp, capture_output=True, text=True, timeout=RUN_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": f"generate()/check() took longer than {RUN_TIMEOUT_SECONDS}s"}
    lines = [ln for ln in proc.stdout.strip().splitlines() if ln.startswith("{")]
    if not lines:
        return {"ok": False, "error": (proc.stderr or proc.stdout or "the generator produced no output").strip()}
    return json.loads(lines[-1])


# ---------------------------------------------------------------------------
# filing one pack
# ---------------------------------------------------------------------------
def file_pack(pack):
    """Validate + generate + write. Returns (ok, errors). Nothing is
    written into the game unless every check passes."""
    errors = validate_pack(pack)
    if errors:
        return False, errors

    story, meta, secret = pack["story"], pack["meta"], pack["secret"]
    palette = story["palette"]
    for fg, bg, minimum, why in CONTRAST_RULES:
        ratio = contrast(palette[fg], palette[bg])
        if ratio < minimum:
            errors.append(f"palette: {fg} on {bg} has contrast {ratio:.2f}:1, needs at least "
                          f"{minimum}:1 ({why})")

    svg = _joined(pack["doodle_svg"])
    code = _joined(pack["data"]["code"])
    errors += check_svg(svg)
    errors += check_code_safety(code)
    errors += check_spoilers(pack)
    if errors:
        return False, errors

    pid = pack["id"]
    os.makedirs(DATASETS_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_csv = os.path.join(tmp, "data.csv")
        result = run_generator(code, pack["data"]["seed"], tmp_csv)
        if not result.get("ok"):
            return False, ["running the pack's code failed:\n" + result.get("error", "unknown error")]

        columns = result["columns"]
        declared = list(meta["columns"])
        missing, extra = set(declared) - set(columns), set(columns) - set(declared)
        if missing or extra:
            if missing:
                errors.append(f"meta.columns describes columns the data doesn't have: {sorted(missing)}")
            if extra:
                errors.append(f"the data has columns meta.columns doesn't describe: {sorted(extra)}")
        if secret["target_column"] not in columns:
            errors.append(f"secret.target_column '{secret['target_column']}' is not a column in the data")
        if not MIN_ROWS <= result["rows"] <= MAX_ROWS:
            errors.append(f"the data has {result['rows']} rows; it must have {MIN_ROWS}-{MAX_ROWS}")
        if not MIN_COLS <= len(columns) <= MAX_COLS:
            errors.append(f"the data has {len(columns)} columns; it must have {MIN_COLS}-{MAX_COLS}")
        if errors:
            return False, errors

        shutil.move(tmp_csv, os.path.join(DATASETS_DIR, f"{pid}.csv"))

    level = pack["level"]
    files = {
        os.path.join(DATASETS_DIR, f"{pid}.meta.json"): {
            "id": pid,
            "category": level,
            "title": meta.get("title") or story["title"],
            "description": meta["description"],
            "n_rows": result["rows"],
            "columns": {c: meta["columns"][c] for c in columns},  # in data order
        },
        os.path.join(SECRETS_DIR, f"{pid}.json"): {
            "id": pid,
            "category": level,
            "fault_type": secret["fault_type"],
            "target_column": secret["target_column"],
            "description": secret["description"],
            "accepted_answers": secret["accepted_answers"],
            "hints": secret["hints"],
        },
        # the story file goes last: its presence is what makes the case
        # show up in the archive, so it must only appear once the rest exists
        os.path.join(DATASETS_DIR, f"{pid}.story.json"): {
            "id": pid,
            "level": level,
            "title": story["title"],
            "hook": story["hook"],
            "narrative": story["narrative"],
            "palette": {**{k: palette[k] for k in PALETTE_KEYS},
                        # derived, not trusted: a dark background flips the
                        # form controls to dark mode
                        "dark": _luminance(palette["bg"]) < 0.2},
            "doodle": f"{pid}.svg",
        },
    }
    os.makedirs(SECRETS_DIR, exist_ok=True)
    os.makedirs(DOODLES_DIR, exist_ok=True)
    with open(os.path.join(DOODLES_DIR, f"{pid}.svg"), "w", encoding="utf-8") as f:
        f.write(svg)
    for path, content in files.items():
        with open(path, "w", encoding="utf-8") as f:
            json.dump(content, f, indent=2)
    return True, []


def _move(src, dest_dir):
    os.makedirs(dest_dir, exist_ok=True)
    name = os.path.basename(src)
    dest = os.path.join(dest_dir, name)
    stem, ext = os.path.splitext(name)
    n = 1
    while os.path.exists(dest):
        dest = os.path.join(dest_dir, f"{stem}_{n}{ext}")
        n += 1
    shutil.move(src, dest)
    return dest


def ingest_inbox():
    """Process every pack waiting in stories_inbox/. Returns one report
    per pack: {file, ok, id, title, level, errors}. Cheap when empty."""
    os.makedirs(INBOX, exist_ok=True)
    reports = []
    with _lock:
        for name in sorted(os.listdir(INBOX)):
            path = os.path.join(INBOX, name)
            if not (os.path.isfile(path) and name.lower().endswith(PACK_EXTENSIONS)):
                continue
            if name.lower() == "readme.txt":
                continue
            report = {"file": name, "ok": False, "id": None, "title": None, "level": None, "errors": []}
            try:
                with open(path, encoding="utf-8") as f:
                    pack = parse_pack(f.read())
                if isinstance(pack, dict):
                    report["id"] = pack.get("id")
                    report["level"] = pack.get("level")
                    report["title"] = (pack.get("story") or {}).get("title") if isinstance(pack.get("story"), dict) else None
                ok, errors = file_pack(pack)
            except Exception as e:  # a bad pack must never take the app down
                ok, errors = False, [f"{type(e).__name__}: {e}"]

            report["ok"], report["errors"] = ok, errors
            if ok:
                _move(path, PROCESSED)
            else:
                dest = _move(path, FAILED)
                with open(dest + ".error.txt", "w", encoding="utf-8") as f:
                    f.write(f"Pack '{name}' was not filed. Fix these and drop it in stories_inbox/ again:\n\n")
                    f.write("\n\n".join(f"- {e}" for e in errors) + "\n")
            reports.append(report)
    return reports


if __name__ == "__main__":
    results = ingest_inbox()
    if not results:
        print(f"Inbox is empty ({INBOX}).")
    for r in results:
        if r["ok"]:
            print(f"FILED     {r['file']} -> [{r['level']}] {r['title']} ({r['id']})")
        else:
            print(f"REJECTED  {r['file']}")
            for e in r["errors"]:
                print("   - " + e.replace("\n", "\n     "))
