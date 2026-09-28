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
