// Turn a story pack (the JSON an AI writes from STORY_PROMPT.md) into a
// playable case, entirely in the browser, with the same checks as the
// desktop ingester (story_ingest.py): screen -> run the generator -> build.
// Used by the Upload tab and by admin Weekly drops.

const GENERATE_TIMEOUT_MS = 60_000;

function runGenerator(code, seed) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./gen-worker.js", import.meta.url), { type: "module" });
    const timer = setTimeout(() => {
      worker.terminate();
      resolve({ ok: false, error: `generate()/check() took longer than ${GENERATE_TIMEOUT_MS / 1000}s` });
    }, GENERATE_TIMEOUT_MS);
    worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); resolve(data); };
    worker.onerror = (e) => { clearTimeout(timer); worker.terminate(); resolve({ ok: false, error: e.message }); };
    worker.postMessage({ code, seed });
  });
}

// -> { errors: [...] } or { errors: [], case: {meta, secret, story, svg}, csv, pack }
export async function processPack(text, engine, onStep = () => {}) {
  await engine.ready;
  onStep("Checking the pack…");
  const screened = await engine.call("screen", { text });
  if (screened.errors.length) return { errors: screened.errors };

  onStep("Generating the dataset…");
  const gen = await runGenerator(screened.code, screened.seed);
  if (!gen.ok) return { errors: ["running the pack's code failed:\n" + gen.error] };

  onStep("Filing the case…");
  const built = await engine.call("build", { pack: screened.pack, columns: gen.columns, rows: gen.rows });
  if (built.errors.length) return { errors: built.errors };
  return { errors: [], case: built.case, csv: gen.csv, pack: screened.pack };
}
