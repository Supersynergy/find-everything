import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import { findBin, track } from "./engine";

export const MODEL_ID = "clap-htsat-q8:c28f2883575e590e04d3146ff0713c2448d691ba:10s-v1";
export function runtimeDir(): string {
  if (process.env.FE_SEMANTIC_RUNTIME) return path.resolve(process.env.FE_SEMANTIC_RUNTIME);
  const installed = path.join(os.homedir(), "Library/Application Support/FindEverything/semantic-runtime");
  if (fs.existsSync(path.join(installed, "worker.mjs"))) return installed;
  return path.resolve(__dirname, "../runtime");
}
export function semanticStatus() {
  const root = runtimeDir();
  let manifest: any;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, "ready.json"), "utf8")); }
  catch (e) { if (e.code !== "ENOENT") throw e; }
  const ready = manifest?.revision === MODEL_ID.split(":")[1] && fs.existsSync(path.join(root, "node_modules/@huggingface/transformers/package.json"))
    && ["config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/audio_model_quantized.onnx", "onnx/text_model_quantized.onnx"].every(name => {
      try { return fs.statSync(path.join(root, "model", name)).size === manifest.files?.[name]?.bytes; }
      catch (e) { if (e.code === "ENOENT") return false; throw e; }
    });
  return { ready: !!ready, model: MODEL_ID, runtime: root, manifest };
}

export class SemanticWorker {
  private detached = process.platform !== 'win32' && process.env.FE_SEARCH_WORKER !== '1';
  private child?: ChildProcess;
  private sequence = 0;
  private pending?: { id: number; resolve: (v: number[]) => void; reject: (e: Error) => void };
  private idle?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  embed(kind: "text" | "audio", value: string, timeout = 20000): Promise<number[]> {
    if (this.queued >= 2) return Promise.reject(new Error("Sound model queue is full; retry after the current request"));
    this.queued++;
    const result = this.tail.then(() => this.perform(kind, value, timeout));
    this.tail = result.catch(() => {}).finally(() => { this.queued--; });
    return result;
  }
  private async perform(kind: "text" | "audio", value: string, timeout: number): Promise<number[]> {
    if (!this.child || this.child.exitCode !== null) this.start();
    clearTimeout(this.idle);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error("Local sound model timed out")); }, timeout);
      this.pending = { id, resolve: v => { clearTimeout(timer); this.pending = undefined; this.idle = setTimeout(() => this.close(), 60000); this.idle.unref(); resolve(v); }, reject: e => { clearTimeout(timer); this.pending = undefined; reject(e); } };
      this.child!.stdin!.write(JSON.stringify({ id, kind, ...(kind === "text" ? { text: value } : { path: value }) }) + "\n");
    });
  }
  private start() {
    if (!semanticStatus().ready) throw new Error("Local sound model is not ready. Run fe semantic setup");
    const child = track(spawn(findBin("node"), [path.join(runtimeDir(), "worker.mjs")], { detached: this.detached, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OMP_NUM_THREADS: "2", TOKENIZERS_PARALLELISM: "false", FE_FFMPEG: findBin("ffmpeg") } }));
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    let length = 0;
    child.stdout!.on("data", d => { length += d.length; if (length > 65536) { this.close(); } });
    lines.on("line", line => {
      length = 0;
      try {
        const r = JSON.parse(line), pending = this.pending;
        if (!pending || pending.id !== r.id) return;
        if (r.error) return pending.reject(Object.assign(new Error(r.error), { code: r.code === "AUDIO_DECODE" ? "AUDIO_DECODE" : "MODEL_RUNTIME" }));
        if (!Array.isArray(r.vector) || r.vector.length !== 512 || r.vector.some(v => !Number.isFinite(v))) throw new Error("Invalid local sound vector");
        pending.resolve(r.vector);
      } catch (e) { this.pending?.reject(e); this.close(); }
    });
    let errors = "";
    child.stderr!.on("data", d => { errors = (errors + d.toString()).slice(-2000); });
    child.stdin!.on("error", e => this.pending?.reject(e));
    child.on("error", e => this.pending?.reject(e));
    child.once("close", () => { lines.close(); if (this.child === child) { this.child = undefined; this.pending?.reject(new Error(`Local sound worker stopped: ${errors.slice(-400)}`)); } });
  }
  close() {
    clearTimeout(this.idle); const c = this.child; this.child = undefined;
    this.pending?.reject(new Error("Local sound worker stopped"));
    if (!c) return;
    try { if (this.detached && c.pid) process.kill(-c.pid, "SIGKILL"); else c.kill("SIGKILL"); }
    catch (e) { if (e.code !== "ESRCH") throw e; }
  }
}
