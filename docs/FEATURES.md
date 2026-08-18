# FEATURES — WebClip

**Type:** REFERENCE | **Version:** 1.0.0 | **Date:** 2026-08-18 | **Status:** CURRENT

> The user-facing capability catalogue: what WebClip does and how each feature behaves.

## Capture

- **Full-page capture** — scroll-and-tile the whole page (or the dominant inner scroll panel — LinkedIn/Gmail/docs/chat feeds) into one PDF. Throttled to Chrome's 2 screenshots/sec; restores the page afterwards; aborts rather than mix pixels if you switch tabs.
- **Visible-area capture** — just the current viewport → one page.
- **Pick a section** — click a scroll pane to **select** it (outline + toast). Selection is optional and cancelable: press **Capture** to save just that section (full-page), or **Clear** / Esc to drop it and capture the whole page. One-shot (cleared after a capture). The outline never appears in the PDF.
- **Cancel** — a running full-page capture can be cancelled mid-flight (the Capture button toggles to Cancel); the page is restored.
- **Declutter** — hide ads, cookie bars, sticky widgets before capture (DOM-only, capture-scoped; no network blocking, no host permissions). Handles fixed/absolute/sticky overlays incl. shadow-DOM web components.

## PDF output

- **Auto (one continuous page)** — the default. The whole capture on a single tall page that reads like the live page (no breaks, no margins). Strip-composited, so even very long pages become one page (up to the ~200in PDF limit). Best for screen.
- **A4 / Letter (printable)** — paginated with **content-aware page breaks**: splits land in the whitespace between lines/paragraphs, never through a line, a coloured chat bubble, or a table cell; larger (paragraph/section) gaps are preferred; the split is pulled up to a clean gap within ~25% of a page, a few px *into* the gap (no trailing sliver); pages are **uniform full A4/Letter** with a little top breathing room.
- **Split a saved PDF into printable pages** (Settings → *Split a PDF*) — turn a saved *Auto* one-page capture into A4/Letter after the fact, as a pure PDF→PDF re-pagination (no re-capture). WebClip captures carry a whitespace profile so the re-split lands on the *same* clean gaps as a direct A4 render.
- **Orientation** — Auto / Portrait / Landscape.
- **Image format** — PNG (lossless, best for text) or JPEG (smaller); very large PNG captures auto-fall to JPEG to keep the file sane (disclosed).
- **Header/footer stamp** (opt-in) — a title header on page 1 and a footer on every page (URL · capture time · page N/M).
- **Clickable links** (on by default) — meaningful `<a href>` targets on the page (http/https/mailto/tel; same-page `#anchors` and `javascript:` skipped) are carried into the PDF as clickable link annotations, positioned over the raster and clipped per page. Best-effort on virtualized feeds (only links currently in the DOM are captured). Toggle in Settings.

## Integrity / provenance

- **Evidence Mode** (opt-in) — a detached SHA-256 of the final PDF + a JSON manifest sidecar (source URL, capture time + timezone, capture id). Honest semantics: the hash is detached (never embedded in the PDF it hashes), and the timestamp is an explicitly *local* clock, not a trusted timestamp.
- **Save checksum** (opt-in) — a `.sha256` sidecar next to the PDF.

## Settings & tools (⚙ gear → options page)

Two tabs: **Settings** (default paper size, image format, declutter, stamp, Evidence subgroup, Advanced) and **Split a PDF** (the re-pagination tool). The popup carries only per-capture choices (mode, paper, layout) and layers them over the saved settings.

- **Advanced → Debug: save raw tiles** — also emits a `…tiles-debug.pdf` (one raw tile per page + crop metadata) so a stitching problem can be reproduced offline.

## Reference / help

- Popup header: **KM** badge → knackmentor.com; **?** → GitHub repo (full help + source); **GitHub** mark → the repo; **⚙** → Settings.

## Permissions (crown-jewel lock)

Standard build requests only `activeTab`, `scripting`, `downloads`, `storage`. Never `<all_urls>` or `debugger`. This is a hard limit of the build.

## Roadmap (not yet shipped)

- **Engine B — Markdown export** — hand off `.md` to markdown-desk: strip images where the content transfers well as text (staying close to the original visual reading), keeping images only for parts not easily text-replaced. (Clickable-link capture, shipped above, is the pre-feature: the DOM link inventory + coordinate mapping it builds is reusable for anchoring Markdown text/links back to the source.)
