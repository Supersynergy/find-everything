# GitHub presentation research and decisions

Reviewed **1 November 2026**, against the 0.14.0 preview/source baseline `48a52dd`. Goal: make Find Everything's capabilities easy to understand without turning folder matches, synthetic pictures or optional setup into misleading product claims. Concurrent development/version changes are not evidence of a released or verified capability.

## Recommendation

Use **broot's task → exact command → relevant visual**, with a restrained product hero and a compact capability/prerequisite map. Put the human outcome first, show the search that produces it, then disclose the preparation required. Keep the full inventory in a linked guide rather than hiding important capabilities in installation instructions.

“Best” here is an editorial judgement about fit for this project, **not** a measured ranking of README conversion rates. This review found no evidence that a particular visual layout causes more stars or downloads.

## What strong projects actually do

| Primary example | Observed presentation pattern | What to adopt here |
| --- | --- | --- |
| [broot](https://github.com/Canop/broot#readme) | Outcome-led headings such as finding a directory, searching, manipulating files and previewing. Relevant commands/keystrokes sit next to separate feature images. Content search gets its own explicit example rather than being inferred from a filename screenshot. | **Main reference.** One image must demonstrate one identifiable behaviour, with a readable query and results. Do not borrow broot's content-search capability as a claim about this app. |
| [fzf](https://github.com/junegunn/fzf#readme) | A short positioning paragraph and four named Highlights precede deeper installation, search syntax, demos and preview examples. | A compact opening promise and recognisable feature groups, followed by copyable examples. Its speed claim belongs to fzf; it is not evidence for Find Everything's speed. |
| [Yazi](https://github.com/sxyazi/yazi#readme) | A broad capability list and video demo, explicit beta status, separate documentation links and a detailed image-preview support table. [Its feature page](https://yazi-rs.github.io/features) gives individual capabilities their own demonstrations. | Explain prerequisites and supported surfaces. Distinguish native UI, CLI, Raycast and optional sound setup instead of implying identical availability. Avoid reproducing the whole technical list above installation. |
| [superfile](https://github.com/yorukot/superfile#readme) | A visually led opening, prominent product demo image and direct navigation to its documentation site. | Make the app recognisable immediately. Do not let a beautiful image replace a capability explanation or occupy most of the page without useful context. |
| [LocalSend](https://github.com/localsend/localsend#readme) | Plain-language positioning, direct download links, screenshots, build instructions and a concise protocol/security explanation. | Connect the visible product to the next step. Explain local-first boundaries clearly and keep download compatibility/signing restrictions close to the call to action. |

These are design references, not proof that more badges, longer GIFs or a larger image necessarily improves adoption. We did not copy third-party artwork.

## Why the previous preview was misleading

The old renderer searched `design` and displayed six files under `/Demo/Documents/Design/`. None of the displayed basenames contained “design”. That proved a **parent-path match**, not filename discovery, document-content search or an understanding of design documents.

The corrected fixture uses:

```text
name:invoice ext:pdf !draft
```

Six PDF **filenames** match across Finance, Clients, Archive and Studio. Distractors include `Invoices/Contract.pdf`, a draft invoice and a non-PDF invoice. The production backend regression verifies that the explicit filename filter removes the folder-only match and the other constraints remove the remaining distractors.

The fixture is shared by the renderer and test; the visual's total comes from the fixture length, not an invented performance counter. Unknown file sizes/dates are not replaced with plausible-looking numbers.

## Feature audit: presentation boundaries

Source review found filename/path search, composable filters, cached size/date/media properties, supported local-rule phrases, saved searches, favourites, optional learning, native preview/actions, incremental updates, virtualised results and CLI/API/MCP/Raycast integration. See the [source-backed capability guide](../FEATURES.md).

The baseline code reviewed for this presentation has **no document full-text search**. SQLite FTS indexes names and directory paths, not document bodies. “Copy Contents”, text previews and MCP response `content` fields are not document-content search. The old “optional content search” line therefore had to be removed, not amplified.

Other boundaries:

- Phrase translation is a bounded local grammar, not a general AI assistant.
- Metadata filters require extraction/property preparation.
- Semantic search is optional prepared **audio** similarity, with checkout-based runtime/model setup; it is not bundled semantic document search.
- A complete indexed snapshot is not complete access to all files, every drive or protected macOS locations.
- The downloadable build remains an Apple Silicon/macOS 15+ **not-notarized preview**. No Gatekeeper workaround is recommended.
- Offscreen native rendering is not an interactive keyboard, VoiceOver or accessibility audit.

Any later implementation of content search needs its own verified contract and new examples before this inventory can claim it.

## Chosen README sequence

1. Product name, outcome-led one-liner, navigation/download link and clear preview restriction.
2. One recognisable native hero that shows an interpretable filename query.
3. Six short capability groups, stated as outcomes with their setup boundaries.
4. A six-card **query-example illustration**. Label it as examples, not captured feature results.
5. Additional useful capabilities in a compact table and a link to the full inventory.
6. Copyable query examples with a Preparation column.
7. One full-width native filter-control image; theme variants and the missing-index state go in collapsible sections.
8. Existing installation, privacy, compatibility and verification information remains available.

This avoids shrinking two dense UI screenshots into half-width cells just to show light and dark appearance. Functional differences matter more than theme differences.

## Image set and provenance

| Asset | What it actually shows | What it does not prove |
| --- | --- | --- |
| `hero.png` | Real production native view composed into a product header; six synthetic filename-filter results | Real personal files, benchmark speed or interactive testing |
| `native-light.png` / `native-dark.png` | The same tested filename query in two appearances | Two different search capabilities |
| `native-filters.png` | The actual native Name filter row, query and matching filename fixtures | A metadata or sound-analysis result |
| `native-missing-index.png` | Actionable missing-index UI | A completed disk scan |
| `feature-map.svg` | Six textual query examples with explicit setup labels | Screenshots or evidence that optional preparation has already run |

All native images are rendered offscreen, without screen capture, opening a visible app window, taking focus, starting the search service or traversing user folders. The synthetic filenames are not disguised as the user's files.

A future metadata demonstration should use real, generated fixtures with different measured properties and verify the query result before rendering. A future sound demonstration needs actual model preparation and a labelled approximate-ranking result. Neither should be fabricated to fill a screenshot slot.

## Reproduce and verify

Prerequisites for artwork generation: macOS/Swift plus Python with Pillow already available. Pillow is an **artwork-authoring dependency**, not a new runtime dependency of the app. These commands do not install anything:

```sh
bun test tests/presentation.test.ts tests/release.test.ts
bash scripts/release/render-preview.sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p presentation_assets_test.py
bun node_modules/typescript/bin/tsc --noEmit
```

The render script first validates the synthetic filename fixture with the production search backend, then renders the native views and composes the hero/feature map. The backend regression indexes **only its temporary fixture directory**, never Home or the whole disk. The compositor can also be rerun independently:

```sh
python3 scripts/release/compose-hero.py docs/release/images docs/release/images
```

After generation, visually inspect the PNG/SVG at GitHub reading size as well as full resolution; passing file checks cannot detect every layout problem. No publication, release-asset replacement, installation or OS-permission grant is part of this presentation change.

## Sources

- [broot README](https://github.com/Canop/broot#readme) — task-specific visual demonstration pattern.
- [fzf README](https://github.com/junegunn/fzf#readme) — Highlights, examples and progressively deeper usage.
- [Yazi README](https://github.com/sxyazi/yazi#readme) and [features](https://yazi-rs.github.io/features) — capability breadth, demonstrations and support boundaries.
- [superfile README](https://github.com/yorukot/superfile#readme) — visually led product presentation.
- [LocalSend README](https://github.com/localsend/localsend#readme) — product/download clarity and security explanation.
- [GitHub: About READMEs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes) — what a README should explain; relative file/image links, generated outline and collapsible sections.
- [GitHub: Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) — supported media attachment mechanisms, not evidence for a marketing uplift.
