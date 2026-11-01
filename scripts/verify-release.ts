import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

interface Asset { name: string; bytes: number; sha256: string }
interface Manifest { version: string; tag: string; architecture: string; preview: boolean; notarized: boolean; assets: Asset[]; codeFiles: string[] }
interface RemoteAsset { name: string; size: number; digest: string | null; state: string }
interface RemoteRelease { draft: boolean; prerelease: boolean; tag_name: string; html_url: string; assets: RemoteAsset[] }
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = join(root, "release-artifacts");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command: string, args: string[]): string => execFileSync(command, args, { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

const version = (JSON.parse(read("package.json")) as { version: string }).version;
const manifest = JSON.parse(read("release-artifacts/release.json")) as Manifest;
check(manifest.version === version && manifest.tag === `v${version}`, "Version/tag mismatch");
check(manifest.preview === true && manifest.notarized === false && manifest.architecture === "arm64", "Preview must not claim notarized, stable or universal distribution");
check(read("src/services.ts").includes(`export const VERSION = "${version}"`), "CLI source version mismatch");
check(read("app/bundle-app.sh").split(`<string>${version}</string>`).length === 3, "Native bundle version mismatch");
check(read("README.md").includes(`releases/tag/v${version}`), "README does not link current release");
check(read("docs/release/RELEASE-NOTES.md").includes("not notarized"), "Notarization limitation missing");
check(manifest.assets.length === 1 && manifest.assets[0].name === "FindEverything.app.zip", "Unexpected archive set");
check(Array.isArray(manifest.codeFiles) && manifest.codeFiles.includes("src/engine.ts") && manifest.codeFiles.includes("app/Sources/FindEverything/main.swift"), "Build source inventory missing");
check(manifest.codeFiles.every(path => !path.split("/").includes("..") && /^(src\/|app\/(Sources\/|MediaProbe\.swift$|FileEvents\.swift$|Package\.swift$|bundle-app\.sh$)|package\.json$)/.test(path)), "Invalid build source inventory");
for (const asset of manifest.assets) {
  check(/^[A-Za-z0-9._-]+$/.test(asset.name), "Unsafe asset path");
  const path = join(artifactDir, asset.name);
  check(asset.bytes > 1000000 && asset.bytes < 300 * 1024 * 1024, "Archive outside payload budget");
  check(statSync(path).size === asset.bytes && sha256(path) === asset.sha256, `Archive integrity failed: ${asset.name}`);
}
const checksums = read("release-artifacts/SHA256SUMS.txt");
for (const asset of manifest.assets) check(checksums.includes(`${asset.sha256}  ${asset.name}`), "Archive checksum missing");
check(checksums.includes(`${sha256(join(artifactDir, "release.json"))}  release.json`), "Manifest checksum missing");

const app = join(root, "app/Find Everything.app");
const plist = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(app, "Contents/Info.plist")]).trim();
check(plist === version, "Built app version mismatch");
check(run(join(app, "Contents/Helpers/fe"), ["--version"]).trim().endsWith(version), "Bundled CLI version mismatch");
run("codesign", ["--verify", "--deep", "--strict", "--test-requirement", '=identifier "com.supersynergy.findeverything" and certificate leaf = H"E3CCA459395B95C297D5EA7954398559810A4819"', app]);
const entries = run("/usr/bin/unzip", ["-Z1", join(artifactDir, "FindEverything.app.zip")]).split("\n").filter(Boolean);
check(entries.every(path => !path.startsWith("/") && !path.split("/").includes("..")), "Archive path traversal");
for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md", "BUN-LICENSE.md"]) check(entries.includes(`Find Everything.app/Contents/Resources/Licenses/${file}`), `Archive lacks ${file}`);
check(!entries.some(path => /\/(?:model|node_modules|backups)\//.test(path) || /\/\.env(?:\.|$)/.test(path)), "Private/optional payload must not ship");
for (const image of ["hero.png", "native-light.png", "native-dark.png", "native-missing-index.png"]) {
  const png = readFileSync(join(root, "docs/release/images", image));
  check(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `Invalid PNG: ${image}`);
  check(png.readUInt32BE(16) >= 1000 && png.length > 4000, `Insufficient image resolution/content: ${image}`);
}
console.log(JSON.stringify({ local: "passed", version, signed: true, notarized: false, preview: true, assets: manifest.assets.length, images: 4 }));

if (process.argv.includes("--published")) {
  const repo = "Supersynergy/find-everything";
  const remote = JSON.parse(run("gh", ["api", `repos/${repo}/releases/tags/${manifest.tag}`])) as RemoteRelease;
  check(remote.draft === false && remote.prerelease === true && remote.tag_name === manifest.tag, "Release is not a visible, correctly labelled preview");
  for (const asset of manifest.assets) {
    const published = remote.assets.find(item => item.name === asset.name);
    check(published?.size === asset.bytes && published.state === "uploaded" && published.digest === `sha256:${asset.sha256}`, `Published archive differs: ${asset.name}`);
  }
  for (const name of ["release.json", "SHA256SUMS.txt"]) {
    const published = remote.assets.find(item => item.name === name);
    check(published?.digest === `sha256:${sha256(join(artifactDir, name))}`, `Published metadata differs: ${name}`);
  }
  const metadata = JSON.parse(run("gh", ["repo", "view", repo, "--json", "isPrivate,defaultBranchRef"])) as { isPrivate: boolean; defaultBranchRef: { name: string } };
  check(metadata.isPrivate === false, "Repository is not public");
  const publishedReadme = JSON.parse(run("gh", ["api", `repos/${repo}/contents/README.md?ref=${metadata.defaultBranchRef.name}`])) as { content: string };
  check(Buffer.from(publishedReadme.content.replaceAll("\n", ""), "base64").toString("utf8") === read("README.md"), "Default branch does not show current README");
  const tree = JSON.parse(run("gh", ["api", `repos/${repo}/git/trees/${manifest.tag}?recursive=1`])) as { truncated: boolean; tree: { path: string; sha: string; type: string }[] };
  check(tree.truncated === false, "Published source tree was truncated");
  const images = ["hero.png", "native-light.png", "native-dark.png", "native-missing-index.png"].map(name => `docs/release/images/${name}`);
  for (const path of [...manifest.codeFiles, ...images]) {
    const content = readFileSync(join(root, path));
    const blob = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    check(tree.tree.some(entry => entry.path === path && entry.type === "blob" && entry.sha === blob), `Published source/image differs from tested build input: ${path}`);
  }
  console.log(JSON.stringify({ published: "passed", public: true, url: remote.html_url, defaultBranch: metadata.defaultBranchRef.name, digestsVerified: 3, productImages: 4 }));
}
