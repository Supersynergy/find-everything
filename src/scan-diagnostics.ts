import path from 'node:path';

const MAX_LINE = 8192;
const MAX_DIRECTORIES = 8192;
const MAX_BYTES = 2 * 1024 * 1024;

/** Scanner stderr is line-oriented. Keep only complete, scoped timeout hints.
 * A hint identifies a directory to verify; it is never evidence of deletion.
 */
export class CloudScanDiagnostics {
  private readonly directories = new Set<string>();
  private pending = '';
  private discardLine = false;
  private bytes = 0;
  private truncated = false;

  constructor(private readonly roots: string[], private readonly cloud: string) {}

  push(text: string) {
    let start = 0;
    while (start < text.length) {
      const end = text.indexOf('\n', start);
      const part = text.slice(start, end < 0 ? undefined : end);
      if (this.pending.length + part.length > MAX_LINE) this.discardLine = true;
      if (!this.discardLine) this.pending += part;
      if (end < 0) break;
      this.finishLine();
      start = end + 1;
    }
  }

  private finishLine() {
    const line = this.pending;
    const valid = !this.discardLine;
    this.pending = '';
    this.discardLine = false;
    if (!valid) return;
    const match = /^(?:\[fd error\]: |find: )(\/[^\r\n\0]+): Operation timed out(?: \(os error 60\))?$/.exec(line);
    if (!match) return;
    const dir = match[1];
    if (path.resolve(dir) !== dir || !(dir === this.cloud || dir.startsWith(this.cloud + '/'))) return;
    if (!this.roots.some(root => root === '/' || root === dir || dir.startsWith(root + '/'))) return;
    if (this.directories.has(dir)) return;
    const bytes = Buffer.byteLength(dir);
    if (this.directories.size >= MAX_DIRECTORIES || this.bytes + bytes > MAX_BYTES) {
      this.truncated = true;
      return;
    }
    this.directories.add(dir);
    this.bytes += bytes;
  }

  finish() {
    this.finishLine();
    return { retryDirectories: [...this.directories], retryDirectoriesTruncated: this.truncated };
  }
}
