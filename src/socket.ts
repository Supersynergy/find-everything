import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import { acquireLock } from "./catalog";
import { INDEX_DIR } from "./engine";

export const DEFAULT_SOCKET = path.join(INDEX_DIR, "run", "search.sock");

export async function listenSocket(server: http.Server, socketPath: string, token: string, version: string, ownerPid?: number) {
  socketPath = path.resolve(socketPath);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("Unix socket path must be at most 100 bytes");
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const owner = fs.lstatSync(dir);
  if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o077)) throw new Error("Socket directory must be owned by you with mode 700");
  const release = acquireLock(socketPath + ".lock");
  const info = socketPath + ".json";
  let listening = false;
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; if (listening) { fs.rmSync(socketPath, { force: true }); fs.rmSync(info, { force: true }); } release(); };
  try {
    if (fs.existsSync(socketPath)) {
      const old = fs.lstatSync(socketPath);
      if (!old.isSocket() || old.uid !== process.getuid?.()) throw new Error("Refusing to replace a non-owned socket or regular file");
      fs.unlinkSync(socketPath);
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    listening = true;
    fs.chmodSync(socketPath, 0o600);
    fs.writeFileSync(info, JSON.stringify({ token, version, apiRevision: 7, pid: process.pid, ownerPid: ownerPid ?? null }), { mode: 0o600 });
    fs.chmodSync(info, 0o600);
    process.once("exit", cleanup);
    server.once("close", cleanup);
    console.error(JSON.stringify({ socket: socketPath, version }));
  } catch (e) { cleanup(); server.close(); throw e; }
}

/** True only while something accepts connections on the socket; a stale
 *  metadata file or a reused pid must not look like a running service. */
export function socketServing(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: boolean) => { if (settled) return; settled = true; req.destroy(); resolve(value); };
    const req = net.connect({ path: socketPath });
    req.once("connect", () => finish(true));
    req.once("error", () => finish(false));
    req.setTimeout(timeoutMs, () => finish(false));
  });
}

/** Keeps a supervisor alive instead of exiting while another owner serves the socket. */
export async function waitForSocketOwner(socketPath: string, pollMs = 2000): Promise<void> {
  while (await socketServing(socketPath)) await new Promise<void>(resolve => setTimeout(resolve, pollMs));
}

export function socketRequest(socketPath: string, route: string): Promise<any> {
  const metadata = fs.lstatSync(socketPath + ".json");
  if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) || metadata.isSymbolicLink()) throw new Error("Unsafe socket credentials permissions");
  const { token } = JSON.parse(fs.readFileSync(socketPath + ".json", "utf8"));
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: route, headers: { Host: "localhost", Authorization: `Bearer ${token}` }, timeout: 10000 }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 4 * 1024 * 1024) req.destroy(new Error("Socket response exceeds 4 MiB")); });
      res.on("error", reject);
      res.on("end", () => {
        try { const data = JSON.parse(body); if (res.statusCode !== 200) throw new Error(data.error || `HTTP ${res.statusCode}`); resolve(data); }
        catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Socket request timed out")));
    req.on("error", reject);
  });
}
