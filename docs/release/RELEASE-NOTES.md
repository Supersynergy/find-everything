# Find Everything 0.3.0 · Apple Silicon preview

Native macOS file search with saved local indexes, a CLI and optional Raycast integration.

![Native search interface rendered with synthetic demo files](https://raw.githubusercontent.com/Supersynergy/find-everything/v0.3.0/docs/release/images/hero.png)

## Changes

- Correct the release sequence after 0.2.0: the intended version is **0.3.0**. After verification of 0.3.0, the owner explicitly requested removal of the incorrectly numbered 0.14.0 release, downloads and public tag. The 0.3.0 downloads and 0.2.0 release are unchanged.
- Automatically schedule an **All (/)** path index on the first application start, once dependencies are ready. Reuse an existing All snapshot. The once-only attempt marker prevents a canceled scan restarting on every launch; retry explicitly from the app.
- Add a compact native footer with real file counts, a progress bar, Pause/Continue and Cancel. Scanning has no known total and shows no invented percentage; lookup preparation reports measured byte progress, capped below 100% until finalization.
- Pause stops the owned worker group, including disk/CPU work. Paused time is excluded from its timeout. A separate guardian cleans up that group if its supervisor crashes while paused. Cancel during scanning keeps the previous snapshot; cancel during lookup preparation keeps the newly completed path snapshot and resumable derived preparation.
- Core first-run indexing works with the macOS system file walker when optional fd/ripgrep/fzf tools are absent. It respects configured exclusions, does not follow directory symlinks or request elevated access; this fallback does not interpret project ignore files. Protected/unreadable locations are outside coverage.
- Add explicitly prepared local document-text search with `content:`. Text/code, extractable PDFs and supported macOS document formats are bounded; OCR is not provided. Content is not indexed automatically. The private local full-text cache is unencrypted and can be cleared without deleting originals.
- Update product images and examples using synthetic native fixtures, with light/dark/narrow/paused indexing states.
- Fix All (`/`) index creation stopping at 1 GiB of streamed path output. The new output budget is capped at 8 GiB and further limited by initial free disk space minus 256 MiB. Existing backpressure, timeout, path guards and atomic replacement remain.
- Require the pinned publisher and Gatekeeper approval in the remote installer. Do not implicitly enable live/nightly indexing during an update.
- Replace unchecked in-app helper downloads with trusted package-manager instructions and a tool recheck.
- Preserve saved typing-delay preferences; clarify missing-index and searching states; improve labels and shared control contrast.
- Include project/Bun notices, release manifest, SHA-256 checksums and privacy-clean product images.

## Download and verification

`FindEverything.app.zip` contains the Apple Silicon app, compiled CLI and native helpers. The complete bundle requires macOS 15 or later; it was built and checked on macOS 15.8.2. Download `SHA256SUMS.txt` and `release.json` beside it, then run:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Checksums detect changed files. They are not trusted publisher identity or notarization evidence.

## Important preview limits

**This build is locally signed and not notarized.** It is not a normal Developer ID-distributed macOS release. Gatekeeper may refuse it; the remote installer intentionally refuses unapproved previews. Do not remove quarantine, disable Gatekeeper or reset privacy permissions to get around this. Build from source with your own identity or wait for a notarized release.

Only the available Apple Silicon environment was exercised. Intel, older macOS, manual complete keyboard/VoiceOver flows, prolonged memory/recovery behaviour and full third-party legal review remain unverified. Native images are offscreen renders of production views with synthetic files, not private screenshots or performance measurements. No release verification performed a whole-disk scan or indexed personal document bodies. Temporary fixture tests exercised real pause/resume, cancellation, supervisor-death cleanup and the no-Homebrew path; the >1-GiB regression exercises byte accounting without allocating or scanning a gigabyte. Automatic first-run All indexing happens when the user launches the updated app; macOS permissions, exclusions and resource limits still apply.

Optional semantic models, runtime dependencies and fd/ripgrep/fzf are not redistributed in the app archive. Review [third-party notices](https://github.com/Supersynergy/find-everything/blob/v0.3.0/THIRD-PARTY-NOTICES.md) and the [release register](https://github.com/Supersynergy/find-everything/blob/v0.3.0/COMPLIANCE.md). No security, legal or accessibility certification is claimed.
