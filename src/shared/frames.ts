// Frame-awareness helpers (Engine A). The capture controller descends into SAME-ORIGIN <iframe>s and
// scrolls/tiles their content as part of a full-page capture (WC-M9). What it cannot reach is a
// CROSS-ORIGIN frame (blocked by the browser's same-origin policy). This module holds the PURE
// decision — "is this page's real content trapped in a frame this capture could not reach (i.e.
// cross-origin)?" — so it is unit-testable without a DOM; the controller supplies measured rects and
// this drives an honest warning instead of silently saving only the visible viewport.

/** Rendered box of an <iframe> element in the TOP viewport (CSS px). */
export interface FrameRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface FrameTrapInput {
  /** The top document's total scrollable height (CSS px). */
  docHeight: number;
  /** window.innerWidth (CSS px). */
  viewportWidth: number;
  /** window.innerHeight (CSS px). */
  viewportHeight: number;
  /** Rendered <iframe> boxes in the top viewport (any origin — the element is measurable even when
   *  its content is not script-accessible). */
  frameRects: FrameRect[];
}

// A frame "dominates" the page when its ON-SCREEN box is tall enough to be the main content AND wide
// enough not to be a sidebar. Height is the primary signal: a fixed-width embedded player (e.g. a
// 644px SCORM/LMS stage) stays dominant in a wide window, so an area-of-viewport test would wrongly
// miss it. Width only rules out skinny side lists. Tuned to fire on full-height embedded apps
// (SCORM/LMS players, embedded document viewers) but NOT on a short embedded video or map.
const MIN_HEIGHT_RATIO = 0.6; // visible frame height vs viewport height
const MIN_WIDTH_RATIO = 0.4; // visible frame width vs viewport width (excludes narrow sidebars)
// The top document counts as "not really scrollable" (so a dominant frame IS the real content) when
// its scroll height barely exceeds the viewport. If the page itself scrolls, the full-page capture
// already covers it and any embedded frame is incidental.
const DOC_SCROLL_SLACK = 0.25;

/**
 * True when the top document barely scrolls yet a large <iframe> dominates the viewport — i.e. the
 * page's real content is inside a frame that a top-frame-only full-page capture cannot reach, so the
 * capture would silently save just the visible area. Pure; the controller feeds it measured values.
 */
export function isFrameContentUncaptured(input: FrameTrapInput): boolean {
  const { docHeight, viewportWidth: vw, viewportHeight: vh, frameRects } = input;
  if (vw <= 0 || vh <= 0) return false;
  if (docHeight - vh > vh * DOC_SCROLL_SLACK) return false; // the page itself scrolls → not frame-trapped
  for (const r of frameRects) {
    if (r.width < 1 || r.height < 1) continue;
    const coverW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)); // on-screen width overlap
    const coverH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)); // on-screen height overlap
    if (coverH >= vh * MIN_HEIGHT_RATIO && coverW >= vw * MIN_WIDTH_RATIO) {
      return true;
    }
  }
  return false;
}
