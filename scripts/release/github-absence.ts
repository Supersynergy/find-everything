import { spawnSync } from "node:child_process";

/** Only a final HTTP 404 proves absence; authentication, rate limits and network failures do not. */
export function requireGitHub404(exitCode: number | null, headers: string, endpoint: string): void {
  const statuses = [...headers.matchAll(/^HTTP\/\S+[ \t]+(\d{3})(?:[ \t]|\r?$)/gm)].map(match => match[1]);
  if (exitCode !== 1 || statuses.at(-1) !== "404") {
    throw new Error(`Expected confirmed HTTP 404 for ${endpoint}; received ${statuses.at(-1) ?? "no HTTP status"} (exit ${exitCode})`);
  }
}

export function verifyGitHubAbsent(endpoint: string): void {
  const result = spawnSync("gh", ["api", "--include", "--silent", endpoint], {
    encoding: "utf8", timeout: 20000, maxBuffer: 65536,
  });
  if (result.error) throw result.error;
  requireGitHub404(result.status, result.stdout, endpoint);
}
