// Pure planning for re-splitting a saved capture into printable pages (re-split path).
// No DOM / pdf-lib here — just the whitespace profile carried in the PDF and the band math.
// The renderer stores a compact whitespace profile in an AUTO capture; re-split reads it back so a
// one-page capture can later be sliced into A4/Letter pages at the SAME clean gaps, without any
// re-rasterization. Non-WebClip PDFs (no profile) fall back to fixed bands.

import { findBreakRow } from './tiles.js';

export interface BreakProfile {
  h: number; // source content height (px) the gaps are measured in
  gaps: [number, number][]; // blank runs [startPx, lengthPx] — whitespace between lines/paragraphs
}

const PROFILE_TAG = 'webclip-breaks/1:';
/** Rows outside a gap are "inked"; well above any blank threshold so findBreakRow never breaks there. */
const INK_SOLID = 1000;

/** Serialize a break profile into a single PDF keyword string (integers only, compact). */
export function encodeBreakProfile(p: BreakProfile): string {
  return (
    PROFILE_TAG +
    JSON.stringify({ h: Math.round(p.h), g: p.gaps.map(([s, l]) => [Math.round(s), Math.round(l)]) })
  );
}

/** Find + parse a WebClip break profile from a PDF's Keywords string. Returns null if absent/invalid. */
export function parseBreakProfile(keywords: string | undefined): BreakProfile | null {
  if (!keywords) return null;
  const at = keywords.indexOf(PROFILE_TAG);
  if (at < 0) return null;
  try {
    const o = JSON.parse(keywords.slice(at + PROFILE_TAG.length)) as { h?: unknown; g?: unknown };
    if (typeof o.h !== 'number' || !Array.isArray(o.g)) return null;
    const gaps = o.g.filter(
      (p): p is [number, number] => Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number',
    );
    return { h: o.h, gaps };
  } catch {
    return null; // malformed -> treat as no profile (fixed bands)
  }
}

/** Reconstruct a per-row "ink" array from blank-gap runs: 0 inside a gap, INK_SOLID elsewhere. */
export function inkFromGaps(h: number, gaps: [number, number][]): number[] {
  const ink = new Array<number>(Math.max(0, h)).fill(INK_SOLID);
  for (const [s, len] of gaps) {
    const end = Math.min(h, s + len);
    for (let y = Math.max(0, Math.floor(s)); y < end; y++) ink[y] = 0;
  }
  return ink;
}

/**
 * Boundary offsets [0, b1, b2, …, h] slicing a source column of height `h` (px) into pages of
 * `pageContentPx` rows. With `ink`, each split is pulled up to the nearest whitespace gap within
 * `lookback` (content-aware, Word-style, shared with the direct paginated path via findBreakRow);
 * without it, fixed bands. Pure — unit-tested.
 */
export function planBands(
  h: number,
  pageContentPx: number,
  lookback: number,
  blankThreshold: number,
  ink: number[] | null,
): number[] {
  const boundaries = [0];
  if (h <= 0) return boundaries;
  const step = Math.max(1, Math.floor(pageContentPx));
  let start = 0;
  while (start < h) {
    const regionH = Math.min(step, h - start);
    const isLast = start + regionH >= h;
    let pageH = regionH;
    if (!isLast && ink) {
      // findBreakRow indexes rows within a region; slice ink to [start, start+regionH).
      pageH = findBreakRow(ink.slice(start, start + regionH), regionH, lookback, blankThreshold);
    }
    start += pageH;
    boundaries.push(start);
  }
  return boundaries;
}
