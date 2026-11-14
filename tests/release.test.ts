import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { requireGitHub404 } from "../scripts/release/github-absence";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const text = (path: string): string => readFileSync(join(root, path), "utf8");

describe("release contract", () => {
  test("deleted GitHub resources require a final HTTP 404, never an unrelated failure", () => {
    assert.doesNotThrow(() => requireGitHub404(1, "HTTP/2.0 404 Not Found\r\n", "fixture"));
    assert.doesNotThrow(() => requireGitHub404(1, "HTTP/1.1 301 Moved\r\n\r\nHTTP/2.0 404 Not Found\r\n", "fixture"));
    for (const [code, headers] of [
      [0, "HTTP/2.0 200 OK\n"], [0, "HTTP/2.0 404 Not Found\n"],
      [1, "HTTP/2.0 401 Unauthorized\n"], [1, "HTTP/2.0 403 Forbidden\n"],
      [1, "HTTP/2.0 429 Too Many Requests\n"], [1, "HTTP/2.0 500 Server Error\n"],
      [1, "network unavailable"], [null, ""], [1, "HTTP/2.0 404 Not Found\nHTTP/2.0 200 OK\n"],
    ] as const) assert.throws(() => requireGitHub404(code, headers, "fixture"), /Expected confirmed HTTP 404/);
  });

  test("package, CLI and native bundle agree on the version", () => {
    const version: string = JSON.parse(text("package.json")).version;
    assert.equal(version, "0.3.46");
    assert.ok(text("src/services.ts").includes(`export const VERSION = "${version}"`));
    assert.equal(text("app/bundle-app.sh").match(new RegExp(`<string>${version.replaceAll(".", "\\.")}</string>`, "g"))?.length, 2);
    assert.ok(text("app/bundle-app.sh").includes('<key>LSMinimumSystemVersion</key><string>15.0</string>'));
  });

  test("installers do not opt users into background indexing or maintenance", () => {
    for (const path of ["install.sh", "scripts/install-local.sh"]) {
      const source = text(path);
      assert.doesNotMatch(source, /^\s*bash\s+scripts\/install-daemon\.sh/m);
      assert.ok(!source.includes("<string>--live</string>"));
    }
  });

  test("first-install publisher and Gatekeeper checks precede user-directory writes", () => {
    const source = text("install.sh");
    assert.ok(source.includes('certificate leaf = H"E3CCA459395B95C297D5EA7954398559810A4819"'));
    const publisher = source.indexOf('--test-requirement "=$EXPECTED_REQUIREMENT"');
    const gatekeeper = source.indexOf('spctl --assess --type execute "$CANDIDATE"');
    const write = source.indexOf('mkdir -p "$HOME/Applications"');
    assert.ok(publisher > 0);
    assert.ok(gatekeeper > publisher);
    assert.ok(write > gatekeeper);
    assert.ok(source.includes('--test-requirement "=$OLD_RULE"'));
  });

  for (const failure of ["publisher", "gatekeeper"] as const) {
    test(`rejected ${failure} leaves an existing installation untouched`, () => {
      const work = mkdtempSync(join(tmpdir(), "fe-release-rejection-"));
      try {
        const home = join(work, "home"), bin = join(work, "bin"), app = join(home, "Applications", "Find Everything.app");
        mkdirSync(app, { recursive: true }); mkdirSync(bin);
        writeFileSync(join(app, "keep.txt"), "previous app");
        function stub(name: string, body: string): void {
          const path = join(bin, name); writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`); chmodSync(path, 0o755);
        }
        stub("curl", "exit 0");
        stub("ditto", 'mkdir -p "$3/Find Everything.app/Contents/Helpers"; printf "#!/bin/sh\\nexit 0\\n" > "$3/Find Everything.app/Contents/Helpers/fe"; chmod +x "$3/Find Everything.app/Contents/Helpers/fe"');
        stub("codesign", failure === "publisher" ? 'echo "fixture: publisher rejected" >&2; exit 1' : 'exit 0');
        stub("spctl", 'echo "fixture: Gatekeeper rejected" >&2; exit 1');
        stub("launchctl", 'echo "UNEXPECTED_SERVICE_MUTATION" >&2; exit 91');
        const result = spawnSync("/bin/bash", [join(root, "install.sh")], { env: { ...process.env, HOME: home, TMPDIR: work, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` }, encoding: "utf8", timeout: 5000 });
        assert.notEqual(result.status, 0);
        assert.ok(result.stderr.includes(`fixture: ${failure === "publisher" ? "publisher" : "Gatekeeper"} rejected`));
        assert.ok(!result.stderr.includes("UNEXPECTED_SERVICE_MUTATION"));
        assert.equal(readFileSync(join(app, "keep.txt"), "utf8"), "previous app");
        assert.equal(existsSync(join(home, ".local")), false);
        assert.equal(existsSync(join(home, "Library")), false);
      } finally { rmSync(work, { recursive: true, force: true }); }
    });
  }

  test("missing-tool setup cannot download and execute mutable upstream binaries", () => {
    const source = text("app/Sources/FindEverything/main.swift");
    assert.ok(!source.includes("enum Downloader"));
    assert.ok(!source.includes("Downloader.install"));
    assert.ok(source.includes('Button("Check tools again")'));
    assert.ok(source.includes("This preview does not download or run missing tools for you."));
  });

  test("bundle carries project and embedded-runtime notices", () => {
    assert.ok(text("app/bundle-app.sh").includes("../LICENSE ../THIRD-PARTY-NOTICES.md ../docs/release/BUN-LICENSE.md"));
    assert.ok(text("THIRD-PARTY-NOTICES.md").includes("JavaScriptCore"));
    assert.ok(text("docs/release/BUN-LICENSE.md").includes("LGPL"));
  });

  test("secret files and generated archives are excluded", () => {
    const ignore = text(".gitignore").split("\n");
    for (const line of [".env", ".env.*", "!.env.example", "release-artifacts"]) assert.ok(ignore.includes(line));
  });
});
