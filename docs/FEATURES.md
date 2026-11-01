# What Find Everything actually does

Capability guide for the **0.3.0 preview source**, reviewed **1 November 2026**. This is a source-backed inventory with regression checks, not a benchmark or a claim that optional sound models and runtimes are bundled.

**The core:** search saved **filenames, paths and prepared properties**, then act on selected files. Version 0.3.0 adds explicitly prepared **document full-text search** with `content:`. No OCR or semantic document search is provided.

[Back to the README](../README.md) · [Presentation research](release/README-RESEARCH.md)

## 1. Find filenames across folders

- Search the saved path index; a query need not match the parent folder.
- Use `name:` to restrict a fragment to the **filename**, rather than any part of its path.
- Restrict by folder with `in:`, including a quoted absolute path or a supported alias such as `downloads`.
- Combine extensions with semicolons: `ext:pdf;md`.
- Use file groups: audio, video, image, document, code, archive, application or hidden files.
- Exclude a path fragment with `!draft`; combine alternatives with `invoice|receipt`.
- Quote literal phrases and names containing spaces.
- Browse the saved index with an empty search.

```text
name:invoice ext:pdf !draft
ext:pdf;md in:downloads
name:"annual report" ext:pdf
invoice|receipt ext:pdf
```

**Important distinction:** a normal path query can match a parent folder. `name:invoice` deliberately prevents a file called `Contract.pdf` from matching merely because it lives in `Invoices/`. Neither filename/path mode searches the text inside a PDF; use the explicitly prepared `content:` predicate for document text. Do not promise typo-tolerant matching across every backend: filename/path matching and ranking are the supported contract.

Sources: [query parser](../src/engine.ts#L413-L552), [indexed lookup](../src/path-search.ts), [production-backend screenshot regression](../tests/presentation.test.ts).

## 2. Combine filters and global sorting

| Control | Example | Requirement |
| --- | --- | --- |
| Filename / folder / type | `name:invoice in:documents ext:pdf` | Saved path index |
| Multiple extensions | `ext:wav;flac;mp3` | Saved path index |
| Size comparison or inclusive range | `size:>10m`, `size:=0`, `size:1m..10m` | Cached file properties |
| Modified within a period | `dm:7d`, `dm:week`, `dm:month` | Cached file properties |
| Name / path ordering | `sort:name`, `sort:name-desc`, `sort:path`, `sort:path-desc` | Saved path index |
| Largest / smallest / newest / oldest | `sort:big`, `sort:small`, `sort:new`, `sort:old` | Cached file properties |
| Favourites | `favorites:true ext:pdf` | Previously pinned files |
| Visibility override | `view:all` | Reveals indexed paths only, not excluded/unindexed files |

The native app exposes clickable column sorting, a separate sort bar and filter rows for Name, Path, Type, Size and Modified. File groups and common size/date conditions have presets; extensions can be combined in the Type row.

Filters and sorts operate over the indexed candidate set **before pagination**, not just the rows currently onscreen. Missing size/date metadata remains unknown; it is not treated as zero. Prepare it explicitly:

```sh
fe properties --index work --max-files 10000 --seconds 30
```

Repeat bounded preparation while work remains. Inspect coverage before interpreting an empty result as absence.

Sources: [native filter controls](../app/Sources/FindEverything/ColumnFilters.swift), [column definitions and query options](../app/Sources/FindEverything/Presentation.swift), [complete-search regressions](../tests/complete.test.ts), [coverage contract](COMPLETE-SEARCH.md).

## 3. Turn supported phrases into local filters

Supported German/English file phrases are translated by **local rules**, without a chat model:

| Input | Normalised query |
| --- | --- |
| `(PDFs größer als 10 MB)` | `ext:pdf size:>10m` |
| `(Dateien aus den letzten 7 Tagen)` | `dm:7d` |
| `alle meine sounds die unter 1 sekunde gehen` | `type:audio duration:<1s` |

File clauses also support recognised folder aliases, quoted names/folders, favourites and supported ordering phrases. Search details expose the normalised query.

This is a bounded grammar, **not** arbitrary conversational understanding or general translation. Unsupported file conditions can be rejected. Parenthesised sound descriptions use the separate optional audio route below; not every parenthesised phrase is a file filter.

Sources: [file-intent translator](../src/file-intent.ts), [normalisation and audio vocabulary](../src/smart-query.ts), [phrase regressions](../tests/file-intent.test.ts).

## 4. Find media by actual properties

Query extracted metadata, not just an audio-looking filename:

```text
audio: duration:<1s channels:1
audio: duration:100ms..1s samplerate:>=44.1k
image: width:>=1920 height:>=1080
video: duration:>30s
```

Available fields include duration/length, channels, sample rate, bitrate, width and height. Fields can use comparisons and inclusive ranges where meaningful. Availability depends on the file format and extractor.

**Preparation:** create the intended index, then explicitly extract metadata with the app's audio/indexing actions or `fe enrich`. Analysis is bounded and reuses unchanged results; missing, broken or unreadable media stays unknown. Native audio extraction has an external `ffprobe` fallback; image/video extraction uses the external probe path.

The filename need not contain “short”, “mono” or the requested dimensions. Metadata search is **not** visual image recognition, speech transcription or searching lyrics.

Sources: [media extraction/search](../src/media.ts), [query-field definitions](../src/smart-query.ts), [media coverage/boundary tests](../tests/smart.test.ts), [preparation guide](SMART-SEARCH.md).

## 5. Optionally find sounds by description

```text
(kurze düstere Lasersounds)
sound:"metallic futuristic laser sound effect" duration:<1s
```

A local CLAP model compares a text description with **prepared audio vectors**. File type, folder, duration and channel filters can constrain the candidate set before ranking. This is audio similarity, not semantic search over documents.

**Optional, not bundled:** checkout-based runtime files, Bun/Node, explicit model downloads, FFmpeg and an explicit audio-analysis pass are required. The standalone app archive does not by itself make this workflow ready. The native settings expose setup and analysis actions; runtime files still need to be installed from the checkout.

After setup, inference stays local. The analysed excerpt is at most the **first ten seconds** of a file. The German-to-English sound vocabulary is limited; English descriptions are the more dependable input. Similarity is approximate, scores are not probabilities and this route never reports exhaustive certainty with `complete:true`.

Sources: [setup, limitations and pinned model](SEMANTIC-AUDIO.md), [semantic search](../src/semantic.ts), [runtime and decoding](../runtime/worker.mjs), [native audio settings](../app/Sources/FindEverything/SearchSettings.swift#L138-L145).

## 6. Get from a result to the next action

### Native app

- Navigate results with arrows, page keys and Home/End; type-to-search and focus shortcuts preserve a keyboard workflow.
- Select multiple files with Command/Shift-click and keyboard range selection.
- Open with Return; open the enclosing folder with Command-Return.
- Preview with Space/Quick Look and step through a selection.
- Reveal in Finder, choose **Open With**, or remember a preferred app for an extension inside Find Everything only.
- Copy names/paths/content where the action supports it, open a folder in Terminal, duplicate, compress, share or move selected files to Trash.
- Search inside the selected folder without dropping the other filters.
- Use the action menu, right-click context menu, or keyboard shortcuts.

Copying contents and showing a preview do **not** imply that document contents are indexed or searchable. File actions are explicit; ordinary search is not a file-management mutation.

Sources: [native actions](../app/Sources/FindEverything/main.swift#L1400-L1436), [Quick Look](../app/Sources/FindEverything/QuickPreview.swift), [opening preferences](../app/Sources/FindEverything/Presentation.swift#L182), [keyboard/navigation contract](SMART-SEARCH.md#fenster-maus-und-tastatur).

## 7. Keep useful work close

- **Saved searches:** retain a query with its folder/project scope; reopen or remove it from the native UI.
- **Favourites:** persistent local pins shared with the CLI; combine them with name/type/property filters.
- **History:** revisit previous searches; remembering new entries is configurable.
- **Optional local learning:** successful opens can improve query-specific relevance. Merely typing a query does not train it; explicit sorts take priority. Disable or reset learning in settings.
- **Visibility preferences:** hide system/generated/hidden/noisy paths from a view without deleting the index. `view:all` cannot restore paths that were never indexed.
- **Your view:** light/dark/system appearance, font size, compact/striped rows, file icons, visible columns, keyboard hints, preview/autoplay preferences, popup/window mode and Dock visibility.

Sources: [settings and saved-search controls](../app/Sources/FindEverything/SearchSettings.swift), [saved searches](../app/Sources/FindEverything/main.swift#L810-L821), [bounded learning](../src/search-learning.ts), [ranking rules](SEARCH-RELEVANCE.md).

## 8. Choose and maintain the search area

- Built-in scopes include Home, Documents, Downloads and Applications. Add a chosen folder/project or a profile with multiple roots.
- First app launch schedules **All** once, respecting its configured roots/exclusions. Existing All snapshots are reused. Subsequent full rebuilds are explicit; a missing selected scope exposes indexing actions rather than pretending it has zero files.
- The footer exposes count-only scanning, measured lookup-preparation progress, pause/resume acknowledgement and cancellation. Canceling a scan preserves the prior valid snapshot; canceling lookup preparation retains the completed new path snapshot and resumable preparation.
- Combine saved indexes without another filesystem traversal, deduplicating overlapping paths.
- Prepare a derived fast lookup from an existing path snapshot without scanning the directory tree again.
- Enable incremental updates from the macOS file journal. Journal gaps are visible and need explicit reconciliation; they do not trigger a hidden full scan.
- Browse the match set in a virtual native table. Nearby pages and icons are cached with resource bounds instead of rendering every indexed path at once.

A saved snapshot is not proof that all drives or protected files were indexed. Permissions, root choices, excludes, unknown properties and journal state still matter. No SSD-lifetime or universal speed improvement has been established by these features.

Sources: [index profiles](../src/catalog.ts), [combined indexes](../src/combine.ts), [incremental updates](LIVE-INDEX.md), [native virtual table](../app/Sources/FindEverything/VirtualResultTable.swift), [resource-aware results](../app/Sources/FindEverything/VirtualResults.swift).

## 9. Use the engine in your workflow

| Surface | Available capabilities | Distribution/setup boundary |
| --- | --- | --- |
| **Native macOS app** | Search/filter/sort, preview/actions, scopes, saved searches, preferences, explicit preparation | Apple Silicon preview; macOS 15+ complete bundle; not notarized |
| **CLI** | Search JSON, index/status/preparation, properties/media operations, preview, favourites, local service, MCP | Bundled `fe`; install the CLI link or invoke the bundled helper; external search tools may still be needed |
| **Local service/API** | Shared search contract, coverage/counts and stable pages | App normally uses a restricted Unix socket with authentication; not a public cloud API |
| **MCP** | `search_files`, `list_indexes`, `query_help`, `prepare_index`, `index_properties`, `refresh_index` | Configure a local `fe mcp` process; preparation/rebuild tools are explicit writes |
| **Raycast** | Separate search interface using the CLI, index selection and its own subset of preview/file actions | Requires Raycast, extension build/import and an installed `~/.local/bin/fe`; not the native app's complete UI |
| **Repository export helper** | Export known matching media pages to CSV | `scripts/export-media.ts`; checkout helper, not a bundled export button |

Structured replies expose `normalizedQuery`, match counts, `nextOffset`, `snapshotId`, coverage and warnings as applicable. Agents must keep page snapshots consistent and must not treat an incomplete empty response as proof that no matching file exists.

Sources: [CLI commands](../src/cli.ts), [service and MCP tools](../src/services.ts#L233-L239), [Raycast interface](../src/search-files.tsx), [media export helper](../scripts/export-media.ts), [bundle contents](../app/bundle-app.sh).

## Document text in 0.3.0

```sh
fe content index --index work --max-files 500 --seconds 30 --json
fe search 'content:"quarterly revenue" ext:pdf sort:name' --index work --json
fe content status --index work --json
fe content clear --index work --json
```

- Native preparation: **Settings → Indexes → Index document contents**. The same query reaches CLI, local API/MCP and Raycast through the shared backend; these surfaces do not all expose preparation buttons.
- Preparation consumes only paths in the selected saved snapshot and its live overlay. No recursive folder walk or query-time source-document read is performed. Re-run indexing after document edits.
- UTF-8 text/code, extractable PDFs (bundled PDFKit helper; optional `pdftotext` + `pdfinfo` fallback for unbundled CLI, skipped if the page count cannot be verified), and macOS Office/RTF (`textutil`) are supported. No OCR, password guessing, image semantics or arbitrary binary decoding.
- Text/source extraction is limited to 2 MiB. PDF/Office source files are limited to 32 MiB; PDFs to 1,000 pages. Hidden paths, symlinks, unsupported encodings/formats and extraction failures are skipped and reported as incomplete coverage.
- Cached text is stored locally with owner-only permissions, **not encryption**. Clearing this cache does not remove original files. SQLite storage and query candidate sets are bounded; warnings disclose incomplete indexing or limited results. Search replies keep `complete:false` because cached text cannot prove current filesystem completeness; `coverage.cachedSnapshotComplete` separately describes the prepared cache.
- Filename/path/extension/exclusion/favourite/size/date filters and global sort precede pagination. Mixing document text with audio similarity or media-property predicates is rejected explicitly rather than silently ignoring a condition.

Sources: [content index and query implementation](../src/content-search.ts), [PDFKit extraction helper](../app/ContentProbe.swift), [content regressions](../tests/content-search.test.ts), [CLI/shared-route regressions](../tests/content-query.test.ts), [native action regression](../tests/native/content.swift).

## What not to claim

No OCR; no automatic document-content scanning; no semantic PDF or image search; no general-purpose AI understanding; no automatic access to every file; no bundled ready-to-use audio model; no feature parity across native app/Raycast/CLI; no measured “fastest on macOS” or SSD-lifetime claim; no trusted/notarized release or completed accessibility audit without the corresponding evidence.
