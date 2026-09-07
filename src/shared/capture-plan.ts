// Pure capture-planning math (handover §19.4, §25, §69). No DOM; unit-tested.
// Used by the full-page orchestrator (WC-M4) to plan scroll positions and map
// CSS coordinates to screenshot pixels.

/**
 * Vertical scroll positions to cover a document with viewport-height tiles.
 * `overlap` (CSS px) is subtracted from the step so adjacent tiles overlap slightly;
 * the renderer crops the duplicated band. The last position is clamped to the bottom.
 */
export function buildVerticalPositions(documentHeight: number, viewportHeight: number, overlap: number): number[] {
  if (documentHeight <= viewportHeight || viewportHeight <= 0) return [0];
  const step = Math.max(1, viewportHeight - Math.max(0, overlap));
  const last = documentHeight - viewportHeight;
  const positions: number[] = [];
  for (let p = 0; p < last; p += step) positions.push(p);
  if (positions[positions.length - 1] !== last) positions.push(last);
  // Deduplicate after any rounding (§19.4).
  return positions.filter((v, i, a) => i === 0 || v !== a[i - 1]);
}

/**
 * Actual screenshot scale, measured from the first decoded tile rather than assumed
 * from devicePixelRatio (§25). Browser zoom / display scaling make DPR unreliable.
 */
export function computeScreenshotScale(
  imageWidthPx: number,
  imageHeightPx: number,
  viewportWidthCss: number,
  viewportHeightCss: number,
): { scaleX: number; scaleY: number } {
  return {
    scaleX: viewportWidthCss > 0 ? imageWidthPx / viewportWidthCss : 1,
    scaleY: viewportHeightCss > 0 ? imageHeightPx / viewportHeightCss : 1,
  };
}
