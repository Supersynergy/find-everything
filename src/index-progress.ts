import { spawn, type ChildProcess } from "node:child_process";

export interface IndexProgress {
  phase: "scan" | "prepare" | "complete";
  files: number;
  bytesRead?: number;
  totalBytes?: number;
  paused: boolean;
}

/** Measures running time only; a paused worker must not consume its timeout. */
export class ActiveIndexClock {
  private active = 0;
  private last: number;
  private paused = false;
  constructor(now = performance.now()) { this.last = now; }
  elapsed(now = performance.now()): number {
    if (!this.paused) this.active += Math.max(0, now - this.last);
    this.last = now;
    return this.active;
  }
  setPaused(paused: boolean, now = performance.now()): void { this.elapsed(now); this.paused = paused; }
  reset(now = performance.now()): void { this.active = 0; this.last = now; }
}

export interface IndexJob { done: Promise<void>; cancel(): void }

/** Owns one isolated process group, including fd and SQLite preparation. Never signals a discovered PID. */
export function startIndexJob(command: string, args: string[]): IndexJob {
  if (process.platform === "win32") throw new Error("Pausable indexing requires macOS or Unix");
  const child: ChildProcess = spawn(command, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  // A separate, never-paused guardian observes EOF on a pipe owned by this supervisor.
  // It cleans up this freshly spawned group even if the supervisor receives SIGKILL.
  const workerArg = args.indexOf('_index-job');
  if (workerArg < 0) { child.kill(); throw new Error('Index worker command missing'); }
  const guardian = spawn(command, [...args.slice(0, workerArg), '_index-guardian', String(child.pid)], { stdio: ['pipe', 'ignore', 'ignore'] });
  guardian.stdin!.on('error', () => {});
  let state: IndexProgress = { phase: "scan", files: 0, paused: false };
  let paused = false, closed = false, buffer = "", errors = "", failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const clock = new ActiveIndexClock();
  const emit = (): void => { process.stdout.write(JSON.stringify({ ...state, paused }) + "\n"); };
  const signal = (name: NodeJS.Signals): void => {
    if (closed || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  const cancel = (reason = "Indexing cancelled"): void => {
    if (closed || failure) return;
    failure = new Error(reason);
    // A stopped group cannot handle SIGTERM until resumed.
    if (paused) signal("SIGCONT");
    signal("SIGTERM");
    escalation = setTimeout(() => signal("SIGKILL"), 1000);
  };
  const toggle = (): void => {
    if (closed || failure || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      signal(paused ? "SIGCONT" : "SIGSTOP");
      paused = !paused; clock.setPaused(paused); emit();
    } catch (error) { cancel((error as Error).message); }
  };
  guardian.once('error', () => cancel('Index lifecycle guardian could not start'));
  guardian.once('close', () => { if (!closed) cancel('Index lifecycle guardian stopped unexpectedly'); });
  process.on("SIGUSR2", toggle);
  const timer = setInterval(() => {
    // All-disk first-run work can legitimately take minutes; keep a finite 30-minute
    // active-time budget per phase without charging time spent paused by the user.
    const budget = 30 * 60 * 1000;
    if (clock.elapsed() > budget) cancel("Indexing exceeded its active-time budget; paused time was excluded");
  }, 200);
  child.stderr!.on("data", (data: Buffer) => { errors = (errors + data.toString()).slice(-4096); });
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (data: string) => {
    buffer += data;
    if (buffer.length > 65536) { cancel("Index progress exceeded its message limit"); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as IndexProgress;
        if (!["scan", "prepare", "complete"].includes(event.phase) || !Number.isSafeInteger(event.files) || event.files < 0) throw new Error("Invalid index progress");
        if (event.phase !== state.phase) clock.reset();
        state = event;
        // Already-buffered telemetry may arrive just after SIGSTOP; keep pause authoritative.
        emit();
      } catch { cancel("Invalid index progress from worker"); }
    }
  });
  const done = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      closed = true; clearInterval(timer); if (escalation) clearTimeout(escalation);
      process.removeListener("SIGUSR2", toggle);
      guardian.stdin!.end('complete\\n');
    };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(errors.trim() || `Index worker exited ${code}`));
      else if (state.phase !== "complete") reject(new Error("Index worker ended before completion"));
      else resolve();
    });
  });
  return { done, cancel: () => cancel() };
}
