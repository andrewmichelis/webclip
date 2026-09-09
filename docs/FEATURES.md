# FEATURES — WebClip

**Type:** REFERENCE | **Version:** 1.1.0 | **Date:** 2026-09-06 | **Status:** CURRENT

> **Track: Capture (the feature catalogue)** — *Read this when you want to know what WebClip does and how each feature behaves.*

> The user-facing capability catalogue: what WebClip does and how each feature behaves.

## Capture

### Three capture tools (distinct intents)

| Tool | Popup control | What it does | Ideal use case |
|---|---|---|---|
| **Capture & Save PDF** | `Capture & Save PDF` button | One-click full-page (or inner-panel) capture → saved PDF. The everyday default. | Everything is already on the page: articles, dashboards, receipts, chat threads, docs. |
| **Full page (automated + mark)** | `📄 Full page` button | Captures the whole page automatically as a **base**, then you re-enter the *same page* and **mark** the states one scroll can't reach (a collapsed accordion, a different tab); each marked view is spliced into the base **at its own section, in order**. Anything it can't place with confidence is left out and named — never dropped in the wrong spot. | The full page **plus** content hidden behind interactions — course players (SCORM / Rise), accordion/tabbed docs. |
| **Mark only** | `🎯 Mark only` button | **No base** — mark sections by hand; they stack into one PDF in capture order. The session **persists across pages/lessons** (keep marking as you navigate; **Done** assembles one multi-page PDF). | A custom cut, pages the automatic capture doesn't suit, or when you only need specific parts — even across lessons. |

Both mark tools share one marking engine; they differ only in whether a base is captured first. A marked area taller than the viewport is tiled and stitched with the **same seam-clean pipeline** as full-page capture.

**Marking workflow (the toolbar / keyboard):** arm with **`m`** (or the Mark button) → a dashed outline follows the block under the cursor → click / `m` / `Enter` to lock it → **`↑` grows** the selection to the enclosing block, **`↓` shrinks** it toward the cursor → capture with `m` / `Enter`. `Esc` cancels; the toolbar shows a count, **↶ Undo** (drop the last mark), and **✓ Done**.

- **Accordions** — open the section so its content shows, then mark the open block. It splices into the base at its real position (Full page) or becomes its own stacked section (Mark only).
- **Tabs** — mark a tab's panel, then press **`↑`** so the selection **also includes the tab bar / header**, then capture; repeat for each tab (including the default). Marking each tab *with its shared header* is what lets the atlas locate the widget and stack all its tabs together, in order, at the right place. Marking only the panel leaves the tabs unplaceable.

### Core capture

- **Full-page capture** — scroll-and-tile the whole page (or the dominant inner scroll panel — LinkedIn/Gmail/docs/chat feeds) into one PDF. Throttled to Chrome's 2 screenshots/sec; restores the page afterwards; aborts rather than mix pixels if you switch tabs. Content behind a **frozen/sticky header** (e.g. GitHub's file bar) is recovered at each seam by overlapping the tiles by the header height — on the default capture, the automated base, and the window-scroll mark alike.
- **Visible-area capture** — just the current viewport → one page.
- **Pick a section** — click a scroll pane to **select** it (outline + toast). Selection is optional and cancelable: press **Capture** to save just that section (full-page), or **Clear** / Esc to drop it and capture the whole page. One-shot (cleared after a capture). The outline never appears in the PDF.
- **Cancel** — a running full-page capture can be cancelled mid-flight (the Capture button toggles to Cancel); the page is restored.
- **Declutter** — hide ads, cookie bars, sticky widgets before capture (DOM-only, capture-scoped; no network blocking, no host permissions). Handles fixed/absolute/sticky overlays incl. shadow-DOM web components.
- **In-frame capture** — when a page's real content lives inside a **same-origin** `<iframe>` (many SCORM/LMS course players, embedded viewers) and the outer page doesn't scroll, full-page capture scrolls *inside the frame* and captures the whole thing, links included. No new permission (it reads the same-origin frame directly). For frames served from a *different* site (which the browser won't let any extension read), it still saves the visible area and **says so** rather than silently truncating.
- **Expand collapsible sections** (opt-in, Settings) — before capture, force native `<details>` open and reveal accordion panels controlled by a collapsed `aria-expanded` trigger, in the page and inside same-origin frames, so content hidden behind accordions/expanders is captured. Best-effort and reversible; defeats "exclusive" accordions (open one, others close) by setting state directly rather than clicking. Off by default.

## PDF output

- **Auto (one continuous page)** — the default. The whole capture on a single tall page that reads like the live page (no breaks, no margins). Strip-composited, so even very long pages become one page (up to the ~200in PDF limit). Best for screen.
- **A4 / Letter (printable)** — paginated with **content-aware page breaks**: splits land in the whitespace between lines/paragraphs, never through a line, a coloured chat bubble, or a table cell; larger (paragraph/section) gaps are preferred; the split is pulled up to a clean gap within ~25% of a page, a few px *into* the gap (no trailing sliver); pages are **uniform full A4/Letter** with a little top breathing room.
- **Split a saved PDF into printable pages** (Settings → *Split a PDF*) — turn a saved *Auto* one-page capture into A4/Letter after the fact, as a pure PDF→PDF re-pagination (no re-capture). WebClip embeds a whitespace profile in **every** one-tall capture it makes — the default `Capture & Save`, the stacked modal/sticky-header path, and the mark/atlas assembly — so the re-split lands on the *same* clean gaps as a direct A4 render, content-agnostically. A PDF made by another tool (no profile) falls back to fixed page heights; re-capture with the current build for clean breaks.
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

- **Bundled Help page** (`help.html`, opened from the popup) — an offline, self-contained guide: the three capture tools + when to use each, the marking flow (the 3 presses), **worked examples with diagrams for accordions and tabs** (including the `↑`-to-include-the-header technique), the floating toolbar, Split PDF, and the keyboard shortcuts. No network needed.
- Popup header: **KM** badge → knackmentor.com; **?/Help** → the bundled Help page; **GitHub** mark → the repo; **⚙** → Settings.

## Permissions (crown-jewel lock)

Standard build requests only `activeTab`, `scripting`, `downloads`, `storage`. Never `<all_urls>` or `debugger`.

## Roadmap (not yet shipped)

- **Engine B — Markdown export** — hand off `.md` to markdown-desk: strip images where the content transfers well as text (staying close to the original visual reading), keeping images only for parts not easily text-replaced. (Clickable-link capture, shipped above, is the pre-feature: the DOM link inventory + coordinate mapping it builds is reusable for anchoring Markdown text/links back to the source.)
