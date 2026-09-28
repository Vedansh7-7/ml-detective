"""
The notebook engine, shared by the desktop app (app.py) and the browser
version (loaded into Pyodide by web/play/py-worker.js).

Pure Python on purpose: nothing heavy is imported here. pandas and
matplotlib are only touched if the player's own code has already
imported them, so the browser doesn't have to download them up front.
"""
import ast
import base64
import hashlib
import io
import itertools
import linecache
import os
import re
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

# headless plotting everywhere (desktop server and browser worker alike);
# must be set before the player's code first imports matplotlib
os.environ.setdefault("MPLBACKEND", "Agg")


def fresh_exec_globals(df):
    """A blank kernel namespace, like a fresh Jupyter/Kaggle notebook: the
    dataset is preloaded as `df`, plus load_data() for a fresh copy any time
    (so overwriting or mutating df is never fatal). The player imports
    whatever they want. Persists across cells for the current case."""
    pristine = df.copy()

    def load_data():
        """Return a fresh, untouched copy of this case's dataset."""
        return pristine.copy()

    return {"__builtins__": __builtins__, "df": pristine.copy(), "load_data": load_data}


def format_value(val):
    """Render a cell's trailing expression roughly like Jupyter would."""
    if val is None:
        return None
    pd = sys.modules.get("pandas")
    if pd is not None and isinstance(val, (pd.DataFrame, pd.Series)):
        try:
            frame = val.to_frame() if isinstance(val, pd.Series) else val
            return {"html": frame.to_html(max_rows=60)}
        except Exception:
            return {"text": repr(val)}
    return {"text": repr(val)}


def _collect_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    images = []
    for num in plt.get_fignums():
        buf = io.BytesIO()
        plt.figure(num).savefig(buf, format="png", bbox_inches="tight")
        images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
    plt.close("all")
    return images


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
                result = format_value(eval(eval_code, glbls))
        images = _collect_figures()
    except Exception as exc:
        # drop the frames that belong to the engine, keep the player's
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename != cell_name:
            tb = tb.tb_next
        error = "".join(traceback.format_exception(type(exc), exc, tb))
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is not None:
            plt.close("all")

    return {"stdout": stdout.getvalue(), "result": result, "images": images, "error": error}


# ---------------------------------------------------------------------------
# answer checking
# ---------------------------------------------------------------------------
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


def _candidates(secret):
    out = list(secret.get("accepted_answers", []))
    if secret.get("target_column"):
        out.append(secret["target_column"])
    return out


def check_answer(user_text, secret):
    """
    Decide whether the player's free-text guess correctly names the
    hidden fault for this dataset.

    Normalize both sides into a bag of meaningful tokens, then accept if
    the guess contains EVERY token of at least one accepted answer (or of
    the target column name). So "age" and "the age column has outliers"
    both match "age", but a lone generic word like "outliers" doesn't
    match "age outliers": the guess has to name the thing, not just the
    kind of problem.
    """
    user_tokens = _normalize_tokens(user_text)
    if not user_tokens:
        return False
    for candidate in _candidates(secret):
        cand_tokens = _normalize_tokens(candidate)
        if cand_tokens and cand_tokens.issubset(user_tokens):
            return True
    return False


# Offline practice play in the browser checks verdicts against hashed
# token sets instead of shipping the answers in readable form. Same rule
# as check_answer: some accepted token set must be a subset of the guess.
def answer_key(tokens, salt):
    return hashlib.sha256((salt + "|" + " ".join(sorted(tokens))).encode()).hexdigest()


def answer_keys(secret, salt):
    sets = [_normalize_tokens(c) for c in _candidates(secret)]
    sets = [s for s in sets if s]
    return {"salt": salt, "max_len": max(len(s) for s in sets),
            "keys": sorted({answer_key(s, salt) for s in sets})}


def check_answer_keys(user_text, keys):
    tokens = sorted(_normalize_tokens(user_text))[:24]  # bounded work
    wanted = set(keys["keys"])
    for size in range(1, min(keys["max_len"], len(tokens)) + 1):
        for combo in itertools.combinations(tokens, size):
            if answer_key(combo, keys["salt"]) in wanted:
                return True
    return False
