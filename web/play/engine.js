// Main-thread handle on the Python worker: promise-based calls, a status
// callback for the "Python: loading/ready" pill, and restart() to recover
// from a runaway cell (terminating the worker is the only reliable stop).

export class Engine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.boot();
  }

  boot() {
    this.seq = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL("./py-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => this.onStatus("error", e.message);
    this.onStatus("loading");
    this.ready = this.call("ping").then(
      (info) => { this.onStatus("ready", info); return info; },
      (err) => { this.onStatus("error", err.message); throw err; });
  }

  call(type, payload = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  restart() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("Python was restarted"));
    this.boot();
    return this.ready;
  }

  get busy() {
    return this.pending.size > 0;
  }
}
