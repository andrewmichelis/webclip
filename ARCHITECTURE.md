# Architecture

WebClip is a Chrome Manifest V3 extension that saves the **rendered** active tab as a PDF. The
design goal is fidelity: the file should match the pixels the browser drew, not a re-layout produced
by the print path. This document explains how the pieces fit together.

## Principles

- **Screenshot fidelity, not print-to-PDF.** The PDF is a faithful raster of what the browser
  rendered. `chrome.tabs.captureVisibleTab` is the source of pixels; the print pipeline is never used.
- **Restore the page, always.** Every change made to capture a page (scroll position, injected
  styles, hidden fixed/sticky elements) is recorded and undone on success, failure, and cancellation.
- **Local-only.** Nothing is uploaded. All compositing happens on the device, and the finished PDF is
  handed to the browser's Downloads. There is no network egress.
- **Minimum permissions.** The shipped build requests only `activeTab`, `scripting`, `downloads`, and
  `storage`. Page access is granted by the user's click and released afterward.

## Components

```
src/
  popup/           Toolbar popup UI: capture options, triggers a capture, "split PDF" and section pick
  options/         Options page (persisted preferences)
  background/      Service worker: orchestration, screenshot capture, artifact/download handling
  content/         Injected page controller: prepares and restores the page, measures geometry
  renderer/        PDF generation: tile compositing, pagination, link annotations, evidence stamp
  shared/          Pure, unit-tested logic: capture planning, tiling math, filenames, types, settings
```

- **Popup (`src/popup`)** — the UI. It reads the active tab, lets the user choose *full page* vs
  *visible area* and *Auto* vs *A4 / Letter*, and sends a `START_CAPTURE` message to the service
  worker. It also drives "pick a section" and "split a saved PDF".
- **Service worker (`src/background`)** — the orchestrator. It resolves and re-verifies the active
  tab, injects the page controller, runs the capture loop, hands tiles to the renderer, saves the
  output, and guarantees page restoration. MV3 workers can be suspended, so it holds no durable state
  in globals.
- **Content / page controller (`src/content`)** — injected into the page. It prepares the page for
  capture (scroll to load lazy content, neutralize fixed/sticky elements so they do not repeat down a
  long capture, optional declutter), reports geometry, and restores every change idempotently.
- **Renderer (`src/renderer`)** — turns captured tiles into a PDF with `pdf-lib`: composites the
  column, paginates it, carries page links across as annotations, and writes the optional evidence
  stamp.
- **Shared (`src/shared`)** — pure functions with no DOM, unit-tested in isolation: capture planning
  (which scroll positions to visit, how to map screen pixels to document pixels), tile overlap math,
  safe filename generation, settings validation, and the shared message/type contracts.

## Capture flow

1. The user clicks WebClip. The popup sends `START_CAPTURE` with the chosen options.
2. The service worker verifies the active tab and injects the page controller.
3. For a full-page capture, the controller finds the dominant scroller, scrolls it to load lazy
   content and learn the true height, and neutralizes fixed/sticky elements. For a visible-area
   capture, it simply prepares the current viewport.
4. The worker captures the viewport tile by tile with `captureVisibleTab`, staying within Chrome's
   documented rate limit of two calls per second, and re-checks tab integrity before every shot so it
   never mixes pixels from another tab.
5. The renderer stitches the tiles into one continuous column. Because virtualized feeds reflow as you
   scroll, the overlap between adjacent tiles is refined by matching pixels rather than trusting the
   scroll delta, which removes sliced or doubled lines at the seams.
6. The column is laid out as a PDF (see Output modes), page links are attached, and the file is saved.
7. The page controller restores the page in a `finally`-style path, whatever the outcome.

## Output modes

- **Auto (one continuous page).** The whole capture becomes a single tall page that reads like the
  screen. It is composited in vertical strips so a very long page is not limited by the browser's
  single-canvas size cap; the only hard ceiling is the maximum PDF page dimension, beyond which it
  falls back to paginated A4.
- **A4 / Letter (printable).** The column is sliced into fixed pages with **content-aware breaks**:
  each split is pulled up to the nearest band of whitespace (measured against the page background) so
  a break never falls through a line of text or a table row. A saved Auto capture can also be
  re-paginated into printable pages later, as a PDF-to-PDF operation, without recapturing.

## Links and evidence

- **Clickable links.** Page links (`http`, `https`, `mailto`, `tel`) are carried into the PDF as
  `/URI` link annotations. The URL is re-validated at the PDF sink and written as a hex string of its
  UTF-8 bytes: hex contains none of the PDF string delimiters, so a crafted link cannot break out and
  inject annotation or action tokens, and the bytes stay plain ASCII so viewers actually recognize the
  URL. A CI check decodes every link in the output PDF and fails on an unparseable or dangerous one.
- **Evidence mode (optional).** Records the URL, a local capture time, and a **detached** SHA-256 of
  the file (never embedded in the PDF it hashes). The semantics are deliberately honest: a local clock
  is a local clock, not an independently trusted timestamp, and the UI says so.

## Build, test, and quality

- **Build.** TypeScript (strict) bundled with esbuild into `dist/` by `scripts/build.mjs`. The product
  version lives in `package.json` and is injected into the manifest at build time.
- **Unit tests.** Vitest covers the pure logic in `src/shared` and the renderer's geometry, pagination,
  and link encoding.
- **Headless harness.** `scripts/harness.mjs` drives a real capture end to end in headless Chrome and
  runs `scripts/verify-pdf.mjs` on the output: page count, uniform page sizes, break placement, and
  that every link is both injection-safe and actually clickable.
- **Release gate.** `scripts/release-check.sh` runs typecheck, tests, build, a production-dependency
  audit, and a manifest-permission check that fails on anything beyond the four permissions above.

## Dependencies

One runtime dependency, `pdf-lib` (pure JavaScript, no install scripts), pinned in the lockfile. Dev
dependencies (TypeScript, esbuild, Vitest, Playwright) are not bundled into the extension.
