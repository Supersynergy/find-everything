# Third-party notices

Find Everything source is licensed under the MIT terms in `LICENSE`. That licence does not replace the terms of third-party components.

## Embedded Bun runtime

The compiled `Contents/Helpers/fe` contains Bun **1.4.4**. Bun describes its own code as MIT-licensed and statically links JavaScriptCore/WebKit and other libraries under their respective licences, including LGPL terms. The upstream licence inventory is reproduced verbatim in [BUN-LICENSE.md](docs/release/BUN-LICENSE.md), also included beside this notice in the app bundle.

Corresponding upstream source and rebuild instructions:

- Bun version used: <https://github.com/oven-sh/bun/tree/bun-v1.4.4>
- Bun source archive: <https://github.com/oven-sh/bun/archive/refs/tags/bun-v1.4.4.tar.gz>
- JavaScriptCore/WebKit source: <https://github.com/oven-sh/WebKit>. Use the WebKit revision pinned by that Bun version, not an arbitrary current revision.
- Bun's licence inventory explains how to rebuild Bun with a modified JavaScriptCore. Rebuild Find Everything's openly available CLI with that Bun executable using `bun run build-cli`.

The app bundle includes the project licence, this notice and Bun's inventory under `Contents/Resources/Licenses`. Consult the linked, versioned upstream source for each component's complete licence, copyright and notice files. This inventory is not a declaration that every component is MIT-licensed.

## Not included in the preview archive

- **fd, ripgrep and fzf:** install separately with a package manager you trust. The app does not download or redistribute their executable archives.
- **Semantic audio runtime and models:** optional checkout-based setup, not included in the app archive. Model-conversion provenance and all applicable licence/notice material must be checked before redistributing weights. Do not treat a base-model licence as proof for an independent conversion.
- **Raycast:** optional integration source. Raycast itself is not included.

Find Everything's Swift helpers are project source, not copies of the optional tools above. Apple frameworks are supplied by macOS rather than redistributed in this archive.
