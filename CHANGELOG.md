# Changelog

All notable changes to WebClip are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## 1.1.0

Capture enhancements and long-page robustness. Same privacy posture, same four permissions, same
local-only design.

### Added
- **Mark-and-assemble capture.** Beyond the single-section picker, arm Mark mode and click several
  regions across a long page; WebClip assembles them into one PDF in the order you picked. Capture the
  whole page plus your marks, or only the marks. Marking can expand accordions and switch tabs as you go.
- **Bundled offline Help page** with worked examples for the marking flow (accordions and tabs).
- **Course / LMS lessons that render inside an iframe are now captured in full** (resolves #1). Same-origin
  frames (e.g. SCORM / Articulate players) are scrolled and tiled like the main page, with collapsed
  sections expanded. Content in a *cross-origin* frame still cannot be read — the browser's same-origin
  policy blocks every extension from it — so WebClip captures what it can and tells you honestly.

### Fixed
- Marking tabs in a tab bar no longer drops the section that follows the widget (e.g. a "Continue"
  button): the tabs stack in order and the trailing content is preserved.
- Long-page stitching is more faithful on tricky layouts. Content pinned behind a sticky/frozen header
  is recovered at every seam instead of being dropped; a page's sticky "current scope" line (as in
  GitHub's code view) is no longer duplicated into the seams; and a dark hero on a light page no longer
  fakes a "frozen footer" that doubled a seam.
- Split PDF now re-paginates every WebClip capture (including marked and stacked ones) on real
  whitespace, so a printable split never cuts through a line.
- Marked-region capture reads a self-scrolling pane's full content, never bakes WebClip's own toolbar
  into the output, and reads an open modal or dialog as a whole.

### Security
- The expanded capture code was re-reviewed before release: no new permission, network egress,
  injection sink, or secret, and the sole runtime dependency stays exact-pinned. A crafted-PDF
  memory-exhaustion path in the re-paginator was found and fixed with a regression test.

### Quality
- 76 unit tests (up from 51) plus the headless capture harness. The release gate now also asserts
  supply-chain integrity (a lockfile is present and every runtime dependency is exact-pinned).

## 1.0.0

First public release. Engine A (visual capture to PDF), feature-complete and security-reviewed.

### Capture
- Capture the visible viewport or the full scrollable page, with scroll-and-tile stitching and
  support for inner scroll panels in web apps (chat feeds, mail, docs).
- Suppress ads, cookie bars, and sticky widgets in the captured output using page heuristics
  ("declutter for capture"), with no network filtering and no host permissions.
- Verify the active tab before every screenshot and restore scroll position and page state after
  capture, on success, failure, or cancellation.

### PDF output
- **Auto** one continuous page (screen-faithful) or **A4 / Letter** printable pages with
  content-aware breaks that split at whitespace and never cut through a line, table row, or bubble.
- Split a saved Auto capture into printable A4 / Letter pages after the fact (PDF-to-PDF).
- Carry the page's `http` / `mailto` / `tel` links into the PDF as clickable, injection-safe link
  annotations.
- Optional header/footer stamp (title, URL, capture time, page number) and a section picker to
  capture a single scroll pane.
- Optional Evidence Mode: URL, title, local capture time, and a detached SHA-256 checksum sidecar,
  with honest semantics (a local clock, not a trusted timestamp).

### Quality & safety
- Local-only by design: no uploads, no analytics, no accounts.
- Minimal permissions: `activeTab`, `scripting`, `downloads`, `storage` only.
- 51 unit tests plus a headless browser harness that captures a real page and asserts the output
  PDF; a release gate enforces typecheck, tests, build, dependency audit, and the permission lock.
