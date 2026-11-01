# Release engineering and compliance register

Snapshot: 2026-11-01 · source baseline `48a52dd` plus the 0.3.0 release changes. The earlier 0.14.0 label was incorrect and is superseded by 0.3.0; this is not a notarized stable release.

**Engineering guidance, not legal advice. No legal, security or accessibility certification.** `RUNTIME` means exercised; `CODE` means source reviewed; `DEDUCED` means inferred. An unknown is not a pass.

## Exposure profile

Confirmed in source: native macOS application, local CLI and optional Raycast integration; local file paths, metadata, preferences, favourites and ranking history. No hosted accounts, payments, advertising or user-content platform found in this scope. Public GitHub distribution is intended worldwide. Operator entity, legal jurisdiction, minors' use and third-party legal obligations are not independently verified. Optional model setup contacts external providers and is not included in the preview app.

## Findings and status

| ID | Severity | Evidence | Status / guard |
|---|---|---|---|
| R1 | HIGH | CODE: first-install publisher was not independently pinned | Fixed: pinned certificate requirement plus Gatekeeper assessment before installation. RUNTIME: isolated rejection tests preserve the previous app and never mutate services. |
| R2 | HIGH | CODE: mutable upstream tools could be downloaded and executed | Removed that downloader. Setup now directs the user to trusted package-manager instructions and can recheck installed tools. RUNTIME: regression check forbids the removed download path. |
| R3 | HIGH | CODE: packaged binary omitted attribution | Bundle now copies project licence, third-party notice and upstream Bun licence inventory. Archive presence is enforced by the release verifier. Full third-party redistribution/legal review is not certified. |
| R4 | MEDIUM | CODE: installers opted users into background indexing | Automatic watcher/nightly setup removed; existing service configuration is preserved. RUNTIME: regression checks prohibit implicit daemon installation. |
| R5 | MEDIUM | CODE: secret-file ignores were missing | `.env` patterns added. RUNTIME: local Gitleaks scanned 18 existing commits; no findings. This is not proof that no secrets exist. |
| R6 | MEDIUM | CODE: privacy/retention explanation was scattered | README now explains stored local data, setup recipients, explicit indexing, support redaction and cleanup. |
| R7 | LAWYER | DEDUCED: optional audio-model conversion terms need verification | Weights/runtime dependencies are not redistributed in the preview archive. Verify exact conversion provenance and notices before any model redistribution. |
| R8 | MEDIUM | CODE: native focus/border contrast and labels | Shared colour pairs adjusted and computed; scope/help/actions labels added. Actual assistive-technology verification remains open. |
| R9 | HIGH | RUNTIME: user reports All (/) indexing aborting at 1 GiB | Fixed with an 8-GiB maximum disk-output budget further bounded by initial free space minus 256 MiB, retaining streaming/backpressure and atomic replacement. RUNTIME: five shard/budget tests pass, including seeded accounting across 1 GiB, budget rejection and path guards. No real >1-GiB scan was run; this is not proof of whole-disk coverage. |

## 0.3.0 review delta

- **RUNTIME:** Six isolated index-control regressions cover real group pause/resume, cancellation while paused preserving the old scan snapshot, supervisor death while paused, native-parent lifetime-pipe EOF, active-time accounting and the no-Homebrew system scanner. No personal disk scan was run. The compiled CLI is tested separately; the native model also exercises its actual compiled child, pause/resume acknowledgement and cancellation.
- **RUNTIME:** First-run model tests schedule All once, reuse existing All snapshots and restore the test preference state. Progress framing is bounded; scan totals are unknown, preparation percentages are measured and remain below 100% until finalization. Four synthetic native footer images cover scan/progress/paused/narrow states. No manual VoiceOver or full interactive-window audit is claimed.
- **CODE:** Automatic first-run **path** indexing is now product behaviour, not installer opt-in to a background daemon. macOS permissions and configured exclusions remain. No project-ignore interpretation is promised for the system-find fallback. Existing watcher/maintenance configuration is not replaced.
- **CODE:** Cancel during the streaming scan leaves the previous published snapshot; cancel during search preparation retains the newly completed path snapshot and resumable derived preparation. The original files are not modified. This is not a transaction spanning arbitrary process crashes or a tested disaster restore.
- **CODE:** Document-body extraction is separate and explicit. Private owner-only local SQLite text caches are **unencrypted**; Clear removes cached content, not source documents, and is not a forensic-erasure guarantee. PDF input/page/output/time bounds and local stdin extraction were independently read. Content search conservatively reports non-exhaustive current-filesystem coverage even for a prepared cache.
- **Independent source review:** durable, bulletproof, lean, evidence-led-ui and compliance-guard reports were collected. The lifecycle review found a native-parent death gap; the added lifetime pipe and EOF regression address it. UI target naming was added to the accessible label. These are scoped reports, not product-wide legal/security/accessibility certificates. Existing coverage rows below retain their earlier scope and do not become a new whole-product pass.

## Numbered pre-deploy coverage

`pass` is scoped to its evidence, not to the entire product. `unverified` is not a certification.

| # | Checklist item | Result | Evidence |
|---|---|---|---|
| 1 | Secret files and history | pass, scoped | Ignore rules; local Gitleaks 18 commits, no findings |
| 2 | Client-database row policies | n-a | No hosted/client-accessible database service found |
| 3 | Public administrator keys | unverified | No comprehensive credential inventory |
| 4 | Object authorization | pass, CODE | Reviewed loopback API token/Host/Origin controls |
| 4a | Granting defaults | unverified | No complete settings/schema sweep |
| 4b | Tenant isolation | n-a | No hosted tenants found |
| 5 | Mass assignment | unverified | No complete data-write audit |
| 6 | Query parameterization | unverified | Not a complete SQLite query audit |
| 7 | Internal endpoint signatures | pass, CODE | Local socket token/ownership controls reviewed |
| 8 | Storage buckets | n-a | No cloud storage buckets found |
| 9 | Resource bounds | pass, scoped CODE | Bounded worker/cache/result payloads; disk-limit bug tracked as R9 |
| 10 | Password storage | n-a | No product accounts found |
| 11 | Login sessions | n-a | No account sessions found |
| 12 | JWT validation | n-a | No JWT authentication found |
| 13 | Credentialed CORS | pass, CODE | Browser-origin/host restrictions reviewed; no live penetration test |
| 14 | Card data | n-a | No payments found |
| 14b | Financial/identity columns | unverified | No comprehensive schema inventory |
| 15 | Sensitive logs | unverified | Support/log retention not comprehensively tested |
| 16 | Transport | pass, scoped CODE | Setup/download URLs use HTTPS |
| 17 | User-controlled URL fetching | n-a, scoped | Optional model origin is fixed; not a complete network audit |
| 18 | Restore drill | unverified | Local app rollback backup exists; no disaster-recovery guarantee |
| A1 | Personal-data disclosure/deletion | pass, CODE | README local-data and cleanup guidance |
| A2 | Public-page third-party scripts | n-a | GitHub-hosted README, not a separate product website |
| A3 | Accounts/login | n-a | No hosted product accounts found |
| A4 | Public-web accessibility | unverified | GitHub UI outside product control; native checks below |
| A5 | Email delivery | n-a | No product email sending found |
| A6 | Contact forms | n-a | No product-hosted forms found |
| A7 | Logs/error tracking | unverified | Runtime egress and retention not exhaustively observed |
| A8 | Operator/entity facts | unverified | No company facts invented |
| X1 | Image alternatives | pass, CODE | Descriptive README image alternatives; native AX unverified |
| X2 | Form/control labels | pass, scoped CODE | Search scope/help/actions labelled; no complete VoiceOver audit |
| X3 | Keyboard operation | unverified | Native regression harness retained; manual complete flow still required |
| X4 | Literal colour contrast | pass, scoped RUNTIME | Focus/boundaries >=3:1; white selected text >=4.5:1; system tertiary colours unverified |
| X5 | Focus visibility | unverified | Explicit native ring present, manual flow not observed |
| X6 | Media controls/captions | unverified | Not a complete media/accessibility audit |
| X7 | Language metadata | unverified | No complete localization audit |
| C-US/C-EU/C-UK | Consumer contract duties | n-a | No consumer payments found |
| P-US/P-EU/P-UK | Hosted platform duties | n-a | Local indexing, not a hosted publishing/messaging platform |
| M1 | Minors | unverified | Possible users; no age gate; child-directed collection not established |

## Remaining decisions and verification

- The downloadable preview is **not notarized**. A trusted normal macOS release requires Developer ID signing, notarization, stapling and real Gatekeeper verification. The remote installer must refuse an unapproved preview; no quarantine or privacy-permission bypass is documented.
- Native renders use synthetic files, not private screen captures. Manual window/keyboard/VoiceOver, older macOS, Intel and long-running memory/recovery tests remain unverified.
- Dependency vulnerability checks against external registries and a full third-party licence/legal review were not performed. Optional model licensing needs an owner/legal decision before redistribution.
- Internal acceptance reports, personal library statistics, delivery receipts and backup paths must not be published with the source snapshot.
