# Find Everything

<img src="docs/release/images/hero.png" alt="Find Everything native macOS search window, showing synthetic design files in a saved Documents index" width="1600" height="1040">

**Search your files. Keep the index on your Mac.**

A native SwiftUI/AppKit file search app, a Bun-powered CLI and an optional Raycast extension. Search saved indexes by name, path, type and file properties, then open, preview or reveal the result without leaving the keyboard.

[**0.14.0 preview release**](https://github.com/Supersynergy/find-everything/releases/tag/v0.14.0) · [Release notes](docs/release/RELEASE-NOTES.md) · [Source licence](LICENSE) · [Third-party notices](THIRD-PARTY-NOTICES.md)

> **Preview, not a notarized macOS release.** The downloadable Apple Silicon build is locally signed, not signed with a trusted Developer ID or Apple-notarized. Gatekeeper may refuse it. We do not recommend disabling Gatekeeper, removing quarantine or changing privacy permissions to bypass this. Build from source with your own signing identity, or wait for a notarized release. Intel and older macOS versions have not been verified.

## What you can do

- **Search a saved scope:** Documents, Downloads, Applications, a chosen folder, or a combined index. Indexing is explicit; a missing scope shows the available indexing actions.
- **Narrow the result:** name/path/type columns, size and date filters, folders, favourites and explicit sorting.
- **Use the keyboard:** search focus, result navigation, range selection, actions, Quick Look and Finder reveal.
- **Keep large lists bounded:** paged results and capped caches instead of one view for every indexed file.
- **Use the same engine elsewhere:** JSON CLI output, local Unix-socket service, MCP and optional Raycast commands.

Optional content search and semantic audio tools require additional checkout-based setup. Models and their runtime dependencies are **not** included in the preview archive.

## Native views, light and dark

| Light | Dark |
| --- | --- |
| <img src="docs/release/images/native-light.png" alt="Light appearance with six synthetic design-file results" width="1040" height="620"> | <img src="docs/release/images/native-dark.png" alt="Dark appearance of the same native search interface and synthetic results" width="1040" height="620"> |

These images render the production SwiftUI/AppKit views with explicitly synthetic `/Demo/Documents` files. They are not captures of personal files, performance benchmarks or evidence of a completed accessibility audit.

<details>
<summary>Missing-index state</summary>

<img src="docs/release/images/native-missing-index.png" alt="Missing Documents index with explicit Index Documents and Index Folder actions instead of a search result" width="1040" height="620">

A missing index is not the same as no matches. The app exposes an indexing action and does not silently start a whole-disk scan.
</details>

## Get the preview

The complete app archive requires **macOS 15 or later on Apple Silicon**; its native helper binaries target macOS 15. It was built and checked on macOS 15.8.2. The source app/CLI target alone is not the compatibility floor of the complete bundle.

The [release page](https://github.com/Supersynergy/find-everything/releases/tag/v0.14.0) contains:

- `FindEverything.app.zip`: Apple Silicon app with its bundled CLI and native helpers.
- `SHA256SUMS.txt`: archive and manifest checksums.
- `release.json`: version, architecture, signature limitations and archive digest.

Download the files to the same directory and check them before opening anything:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Checksums detect changed downloads; they do **not** substitute for trusted publisher signing or notarization. The remote `install.sh` requires its pinned publisher **and** Gatekeeper approval. It deliberately refuses an unapproved preview and preserves an existing installation. It does not select this prerelease as the latest stable download.

### Build from source

Prerequisites: macOS, Xcode Command Line Tools/Swift, Bun and the optional search tools you intend to use. The preview was built on Apple Silicon with Bun 1.4.4; other environments need their own verification. Install prerequisites using a package manager you trust. The app no longer downloads and executes missing tool archives itself.

```sh
git clone https://github.com/Supersynergy/find-everything.git
cd find-everything
bun install --frozen-lockfile
# Optional external search helpers:
brew install fd ripgrep fzf
bun run check
bash scripts/check-keyboard.sh
bash app/bundle-app.sh
# Choose an existing certificate fingerprint from security find-identity:
FE_SIGN_IDENTITY="YOUR_40_CHARACTER_CERTIFICATE_FINGERPRINT" \
  bash scripts/sign-app.sh 'app/Find Everything.app'
```

This creates `app/Find Everything.app`. Signing never falls back to ad-hoc, and it will not silently rotate an installed identity. See [the signing script](scripts/sign-app.sh).

For a local update from a checkout, `bash install.sh --local` makes an app rollback backup and uses the chosen signing identity. It also installs the CLI link, shell completion and the app's login agent. It does **not** opt you into a live indexing daemon or replace existing watcher/maintenance scopes. No installer is run merely by cloning or reading this page.

## CLI quick start

Create one named index for a folder you deliberately choose:

```sh
bun run src/cli.ts index --path "$HOME/Documents" --name work
bun run src/cli.ts search 'report' --index work --json
bun run src/cli.ts search 'ext:pdf size:>10m' --index work --json
bun run src/cli.ts indexes --json
```

Once installed, replace `bun run src/cli.ts` with `fe`. Use `fe --help` for the command list. `fe mcp` provides the local MCP interface; the native app normally uses a permission-restricted Unix socket rather than an exposed remote service.

### Large indexes

The flat path index is streamed to disk with backpressure. Version 0.14.0 replaces the former 1-GiB output cutoff with a finite **8-GiB maximum**, limited further by the free disk space available at the start, leaving a 256-MiB reserve in that initial budget. Timeouts, path-length checks and atomic replacement remain in place. This does not promise an index of every protected macOS file; permissions, excludes, scan time and available disk still apply.

A failed rebuild must not publish a partial index over the previous snapshot. Creating an All (`/`) index remains an explicit action, not something the release process runs on your Mac.

## Local data and privacy

Source review found no hosted product accounts, advertising or product analytics in this scope. This is not a complete runtime-network audit. The application stores file paths, metadata, saved scopes, favourites, preferences and optional ranking history locally:

| Location | Contents |
| --- | --- |
| `~/.cache/hypersearch` | Derived indexes, search databases, socket metadata and logs |
| `~/.config/find-everything` | Index profiles and local signing-identity pin |
| `~/Library/Application Support/FindEverything` | Favourites, ranking/warm-view data, helpers and app rollback backups |
| macOS user defaults for `com.supersynergy.findeverything` | Display, scope and interaction preferences |

Index deletion and removing a saved profile are not deletion of the original files. The normal startup/search path does not require a cloud account. User-requested external actions may open a browser; optional model setup downloads from Hugging Face/npm and needs its own licence review. GitHub hosts source and releases. Installers/package managers contact their own upstreams when you deliberately run them.

For uninstall/cleanup, first quit the app and stop only the Find Everything agents you installed. Back up favourites, preferences and rollback copies you want to keep. Remove the app/CLI/login-agent entries and only then the specific local data directories above if you want a complete reset. Removing those directories discards saved preferences and derived indexes and is not part of a normal update. Never paste unredacted file lists, local paths or socket tokens into a public issue.

## Verification and limitations

Release checks cover project tests/typechecking, native model/navigation/table/presentation tests, bundle signature and version consistency, archive checksums, included notices and product-image presence. Independent report-only passes covered data preservation, security boundaries, licences/privacy, resource bounds and UI source states. These are scoped checks, not a security or legal certification.

Manual screen/keyboard/VoiceOver verification was unavailable because macOS Accessibility/Screen Recording permissions were not granted. Synthetic offscreen rendering does not replace it. Long-running memory/recovery behaviour, Intel, older macOS, full dependency-advisory checks and a complete third-party legal review remain unverified. See [the register](COMPLIANCE.md).

## Contributing

Keep changes focused and run `bun run check`; native changes also need `bash scripts/check-keyboard.sh`. Include a regression test and explain any new network access, stored data or background work. Do not commit credentials, index contents, personal screenshots or local acceptance receipts.

[Report a reproducible bug](https://github.com/Supersynergy/find-everything/issues) with the version, macOS version and a privacy-clean example. Source is MIT; bundled components retain their own terms.
