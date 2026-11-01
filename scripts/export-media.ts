import * as fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DEFAULT_SOCKET, socketRequest } from "../src/socket";

const [index, query, target] = process.argv.slice(2);
if (!index || !query || !target) throw new Error("Usage: bun scripts/export-media.ts INDEX 'audio: duration:<1s' /absolute/output.csv");
const output = path.resolve(target), temporary = output + `.${process.pid}.tmp`;
if (fs.existsSync(output)) throw new Error("Export destination already exists; choose a new filename");
fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
const fd = fs.openSync(temporary, "wx", 0o600);
const cell = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
let bytes = 0, snapshot: string | undefined, offset = 0, count = 0, coverage: any;
const deadline = performance.now() + 60000;
const seen = new Set<string>();
const write = (line: string) => {
  const buffer = Buffer.from(line);
  bytes += buffer.length;
  if (bytes > 32 * 1024 * 1024) throw new Error("Export exceeds 32 MiB; use a narrower query");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written === 0) throw new Error("Export write made no progress");
    offset += written;
  }
};
try {
  write("duration_seconds,channels,sample_rate_hz,codec,source,path\r\n");
  let finished = false;
  for (let page = 0; page < 101; page++) {
    if (performance.now() > deadline) throw new Error("Export exceeded 60 seconds; use a narrower query");
    const result = await socketRequest(DEFAULT_SOCKET, "/v1/search?" + new URLSearchParams({ index, q: query, limit: "1000", offset: String(offset) }));
    if (!result.snapshotId || !Array.isArray(result.media)) throw new Error("Export requires enriched media predicates");
    if (snapshot && snapshot !== result.snapshotId) throw new Error("Media snapshot changed during export; retry");
    snapshot = result.snapshotId; coverage = result.coverage;
    const lines: string[] = [];
    for (const row of result.media) {
      assert(!seen.has(row.path), "Duplicate media page result"); seen.add(row.path);
      lines.push([row.duration, row.channels, row.sampleRate, row.codec, row.source, row.path].map(cell).join(",") + "\r\n"); count++;
    }
    write(lines.join(""));
    if (result.nextOffset === null) { finished = true; break; }
    if (!Number.isInteger(result.nextOffset) || result.nextOffset <= offset || result.nextOffset > 100000) throw new Error("Invalid media pagination cursor");
    offset = result.nextOffset;
  }
  if (!finished) throw new Error("Export exceeded 101 pages; use a narrower query");
  fs.fsyncSync(fd);
  fs.linkSync(temporary, output); // Fails atomically if the destination already exists.
} finally {
  fs.closeSync(fd);
  fs.rmSync(temporary, { force: true });
}
console.log(JSON.stringify({ output, count, bytes, snapshot, coverage }));
