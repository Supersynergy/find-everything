import * as fs from "fs";
import { createInterface } from "readline";
import { indexPathFor } from "./engine";
import { deltaFor } from "./delta";
const checkpoints = new Map<string, { stamp: string; points: Map<number, number> }>();

export async function browse(index: string, limit: number, offset: number) {
  const file = indexPathFor(index), before = fs.statSync(file);
  const delta = deltaFor(index);
  const stamp = `${before.mtimeMs}:${before.size}:${delta.revision}`;
  let cached = checkpoints.get(index);
  if (cached?.stamp !== stamp) {
    if (checkpoints.size >= 8) checkpoints.delete(checkpoints.keys().next().value);
    checkpoints.set(index, cached = { stamp, points: new Map([[0, 0]]) });
  }
  let position = 0, bytes = 0;
  for (const [row, byte] of cached.points) if (row <= offset && row >= position) { position = row; bytes = byte; }
  const source = fs.createReadStream(file, { start: bytes, highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  const paths: string[] = [];
  const deadline = performance.now() + 8000;
  let more = false;
  let endOfBase = true;
  try {
    for await (const line of lines) {
      if (position % 1024 === 0 && performance.now() > deadline) throw new Error("Browse timed out; use the socket service for nearby page checkpoints");
      if (!line) continue;
      const length = Buffer.byteLength(line) + 1;
      if (!delta.visible(line,true)) { bytes += length; continue; }
      if (position < offset) { position++; bytes += length; continue; }
      if (paths.length === limit) { more = true; endOfBase = false; break; }
      paths.push(line);
      position++; bytes += Buffer.byteLength(line) + 1;
    }
  } finally { lines.close(); source.destroy(); }
  cached.points.set(position, bytes);
  if (endOfBase) for (const p of delta.additions) {
    if (position++ < offset) continue;
    if (paths.length === limit) { more = true; break; }
    paths.push(p);
  }
  const after = fs.statSync(file);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Path snapshot changed; restart pagination");
  if (cached.points.size >= 1024) cached.points.delete(cached.points.keys().next().value);
  if (deltaFor(index).revision !== delta.revision) throw new Error("Path updates changed; restart pagination");
  return { paths, nextOffset: more ? offset + paths.length : null, offset, snapshotId: stamp, snapshot: true, complete: true,
    warnings: ["Indexed paths plus incremental changes; configured exclusions and macOS permissions apply."] };
}
