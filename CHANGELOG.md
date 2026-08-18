# Changelog

All notable changes to WebClip are documented here. This project follows
[Semantic Versioning](https://semver.org/).

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
