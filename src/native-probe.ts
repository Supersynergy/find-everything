import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { HOME, track } from "./engine";

export class NativeProbe {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: { resolve: (data: any) => void; reject: (error: Error) => void };
  private buffer = "";
  private failed = false;
  private readonly binary = process.env.FE_MEDIA_PROBE || path.join(HOME, "Applications/Find Everything.app/Contents/Helpers/fe-media-probe");
  used = 0;

  async read(file: string, timeout: number): Promise<any | undefined> {
    if (this.failed || this.binary === "off" || !fs.existsSync(this.binary) || !/\.(mp3|wav|aiff?|m4a|aac|flac|caf)$/i.test(file)) return;
    if (!this.child) {
      this.child = track(spawn(this.binary, [], { stdio: ["pipe", "pipe", "pipe"] }));
      this.child.stderr.resume(); // CoreAudio diagnostics are not persisted.
      this.child.stdin.on("error", e => this.fail(e));
      this.child.on("error", e => this.fail(e));
      this.child.on("exit", () => this.fail(new Error("Native media reader exited")));
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", chunk => {
        this.buffer += chunk;
        if (this.buffer.length > 65536) return this.fail(new Error("Native metadata exceeds limit"));
        const end = this.buffer.indexOf("\n");
        if (end < 0) return;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { const data = JSON.parse(line); const waiter = this.pending; this.pending = undefined; waiter?.resolve(data); }
        catch (e) { this.fail(e); }
      });
    }
    const timer = setTimeout(() => this.fail(new Error("Native media reader timed out")), timeout);
    try {
      const data = await new Promise<any>((resolve, reject) => {
        this.pending = { resolve, reject };
        this.child!.stdin.write(JSON.stringify({ path: file }) + "\n");
      });
      if (data.error || !Number.isFinite(data.duration) || data.duration < 0 || !Number.isFinite(data.sampleRate) || data.sampleRate <= 0 || !Number.isInteger(data.channels) || data.channels < 1) return;
      this.used++; return data;
    } finally { clearTimeout(timer); }
  }

  private fail(error: Error) { this.failed = true; this.child?.kill("SIGKILL"); this.pending?.reject(error); this.pending = undefined; }
  close() { this.child?.kill("SIGKILL"); }
}
