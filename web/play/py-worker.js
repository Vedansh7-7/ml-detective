// The notebook kernel: Python (Pyodide) in a Web Worker, so a long cell
// never freezes the page and every player's code runs on their own device.
// It runs the same kernel.py as the desktop app.

// (a module worker: created with { type: "module" } in engine.js)
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const PYODIDE_VERSION = "314.0.7";

const HOME = "/home/pyodide";
let py = null;
let seabornInstalled = false;

async function boot() {
  py = await loadPyodide();
  await py.loadPackage(["pandas", "micropip"]);  // df is a DataFrame, so pandas is always needed
  const src = await (await fetch("../py/kernel.py")).text();
  py.FS.writeFile(`${HOME}/kernel.py`, src);
  py.runPython(`import sys, json; sys.path.insert(0, "${HOME}"); import kernel`);
  return { python: py.runPython("sys.version.split()[0]"), pyodide: PYODIDE_VERSION };
}
const ready = boot();

let ingestLoaded = null;
function loadIngest() {
  ingestLoaded ??= (async () => {
    const src = await (await fetch("../py/story_ingest.py")).text();
    py.FS.writeFile(`${HOME}/story_ingest.py`, src);
    py.runPython("import story_ingest");
  })();
  return ingestLoaded;
}

const handlers = {
  async ping() {
    return ready;
  },

  // fresh kernel namespace with only `df` in it
  async start({ csv }) {
    py.FS.writeFile(`${HOME}/case.csv`, csv);
    return JSON.parse(py.runPython(`
import pandas as pd
_df = pd.read_csv("${HOME}/case.csv")
G = kernel.fresh_exec_globals(_df)
json.dumps({"shape": list(_df.shape)})`));
  },

  // clear every variable and give back a clean df (the game and its score carry on)
  async reset() {
    py.runPython("G = kernel.fresh_exec_globals(_df)");
    return { ok: true };
  },

  async run({ code, cellName }) {
    // fetch whatever the cell imports (sklearn, scipy, matplotlib...) on first use
    await py.loadPackagesFromImports(code);
    if (!seabornInstalled && /\bseaborn\b/.test(code)) {
      await py.runPythonAsync("import micropip\nawait micropip.install('seaborn')");
      seabornInstalled = true;
    }
    py.globals.set("_code", code);
    py.globals.set("_cell", cellName);
    const t0 = performance.now();
    const out = JSON.parse(py.runPython("json.dumps(kernel.run_code(_code, G, _cell))"));
    out.runtime = (performance.now() - t0) / 1000;
    return out;
  },

  // story packs (Upload, Weekly drops): the desktop ingester's own checks
  async screen({ text }) {
    await loadIngest();
    py.globals.set("_text", text);
    return JSON.parse(py.runPython(`
try:
    _pack = story_ingest.parse_pack(_text)
    _errs = story_ingest.screen_pack(_pack)
except ValueError as _e:
    _pack, _errs = None, [str(_e)]
ok = not _errs
json.dumps({"errors": _errs, "pack": _pack if ok else None,
            "code": story_ingest._joined(_pack["data"]["code"]) if ok else None,
            "seed": _pack["data"]["seed"] if ok else None})`));
  },

  async build({ pack, columns, rows }) {
    await loadIngest();
    py.globals.set("_pack_json", JSON.stringify(pack));
    py.globals.set("_cols", JSON.stringify(columns));
    py.globals.set("_rows", rows);
    return JSON.parse(py.runPython(`
_errs, _case = story_ingest.build_case(json.loads(_pack_json), json.loads(_cols), int(_rows))
json.dumps({"errors": _errs, "case": _case})`));
  },

  // offline verdict: hashed answer keys, same rule as kernel.check_answer
  async check({ text, keys }) {
    py.globals.set("_text", text);
    py.globals.set("_keys", JSON.stringify(keys));
    return py.runPython("kernel.check_answer_keys(_text, json.loads(_keys))");
  },
};

onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready;
    postMessage({ id, ok: true, result: await handlers[type](data) });
  } catch (err) {
    postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
