// Runs a story pack's generate(rng) + check(df) in its own throwaway worker,
// so a slow or runaway pack can be killed (terminate) without touching the
// player's notebook. Mirrors story_ingest.RUNNER: the fault must survive a
// CSV round-trip, because the CSV is what players load.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const ready = (async () => {
  const py = await loadPyodide();
  await py.loadPackage(["numpy", "pandas"]);
  return py;
})();

const RUN = `
import io, json, traceback
import numpy as np
import pandas as pd

ns = {"np": np, "pd": pd, "__name__": "pack"}
try:
    exec(compile(_code, "<pack code>", "exec"), ns)
    df = ns["generate"](np.random.default_rng(int(_seed)))
    if not isinstance(df, pd.DataFrame):
        raise TypeError("generate(rng) must return a pandas DataFrame, got " + type(df).__name__)
    if not bool(ns["check"](df.copy())):
        raise AssertionError("check(df) returned False on the generated data -- "
                             "generate() did not plant the fault check() looks for")
    csv = df.to_csv(index=False)
    reloaded = pd.read_csv(io.StringIO(csv))
    if not bool(ns["check"](reloaded)):
        raise AssertionError("check(df) passes on the DataFrame but fails on the saved CSV. "
                             "The player loads the CSV, so the fault must survive a CSV "
                             "round-trip (dates become strings, categories become text, floats get rounded)")
    _out = {"ok": True, "csv": csv, "rows": len(reloaded), "columns": list(reloaded.columns)}
except Exception:
    _out = {"ok": False, "error": traceback.format_exc(limit=4)}
json.dumps(_out)
`;

onmessage = async ({ data }) => {
  try {
    const py = await ready;
    py.globals.set("_code", data.code);
    py.globals.set("_seed", data.seed);
    postMessage(JSON.parse(py.runPython(RUN)));
  } catch (err) {
    postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
