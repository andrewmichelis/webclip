// Pure planning for re-splitting a saved capture into printable pages (§28, re-split path).
// No DOM / pdf-lib here — just the whitespace profile carried in the PDF and the band math.
// The renderer stores a compact whitespace profile in an AUTO capture; re-split reads it back so a
// one-page capture can later be sliced into A4/Letter pages at the SAME clean gaps, without any
// re-rasterization. Non-WebClip PDFs (no profile) fall back to fixed bands.

import { findBreakRow } from './tiles.js';

export interface BreakProfile {
  h: number; // source content height (px) the gaps are measured in
  gaps: [number, number][]; // blank runs [startPx, lengthPx] — whitespace between lines/paragraphs
  // Where the CONTENT sits inside the source page (top-down pt). When a stamp is on, the one-tall PDF
  // has a header/footer band, so the content is offset from the page top and shorter than the page.
  // Re-split needs these to map content-px -> source-pt correctly (else it slices; the header-band bug).
  contentTopPt?: number; // pt from the page top to the content top (= header band); default 0
  contentHeightPt?: number; // pt height of the content region (excludes stamp bands); default = page height
  // Multi-page WebClip source (AUTO overflow > ~200in → several tall pages). One entry per SOURCE PAGE,
  // in order: where that page's content sits in the global column (px) + its own pt geometry. Lets re-split
  // do content-aware breaks page-by-page (source-page boundaries are already on whitespace).
  pages?: Array<{ s: number; h: number; ct: number; ch: number }>; // s=content-start px, h=content px, ct=contentTopPt, ch=contentHeightPt
}

const PROFILE_TAG = 'webclip-breaks/1:';
/** Rows outside a gap are "inked"; well above any blank threshold so findBreakRow never breaks there. */
const INK_SOLID = 1000;
// Upper bound on a profile's content height (px). A real one-tall capture is well under ~100k px (AUTO caps
// the page at ~14400pt); this ceiling is ~20× that. It exists because the profile is read from the Keywords of
// a USER-CHOSEN PDF: a crafted "WebClip" file could set an absurd `h` and, since `inkFromGaps` does
// `new Array(h)`, exhaust memory (worker DoS) when the victim runs Split PDF on it. Beyond the cap → reject the
// profile → fall back to fixed bands (already output-page-capped in resplit.ts). Security T-4.
const MAX_PROFILE_H = 2_000_000;
const validH = (h: unknown): h is number => typeof h === 'number' && Number.isFinite(h) && h > 0 && h <= MAX_PROFILE_H;

/** Serialize a break profile into a single PDF keyword string (integers only, compact). */
export function encodeBreakProfile(p: BreakProfile): string {
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const o: { h: number; g: [number, number][]; ct?: number; ch?: number; p?: [number, number, number, number][] } = {
    h: Math.round(p.h),
    g: p.gaps.map(([s, l]) => [Math.round(s), Math.round(l)]),
  };
  if (p.contentTopPt !== undefined) o.ct = r2(p.contentTopPt);
  if (p.contentHeightPt !== undefined) o.ch = r2(p.contentHeightPt);
  if (p.pages && p.pages.length) o.p = p.pages.map((pg) => [Math.round(pg.s), Math.round(pg.h), r2(pg.ct), r2(pg.ch)]);
  return PROFILE_TAG + JSON.stringify(o);
}

/** Find + parse a WebClip break profile from a PDF's Keywords string. Returns null if absent/invalid. */
export function parseBreakProfile(keywords: string | undefined): BreakProfile | null {
  if (!keywords) return null;
  const at = keywords.indexOf(PROFILE_TAG);
  if (at < 0) return null;
  try {
    const o = JSON.parse(keywords.slice(at + PROFILE_TAG.length)) as { h?: unknown; g?: unknown; ct?: unknown; ch?: unknown; p?: unknown };
    // Reject an absurd or malformed height before it reaches `new Array(h)` (T-4). Fall back to fixed bands.
    if (!validH(o.h) || !Array.isArray(o.g)) return null;
    const gaps = o.g.filter(
      (p): p is [number, number] => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]),
    );
    const prof: BreakProfile = { h: o.h, gaps };
    if (typeof o.ct === 'number' && Number.isFinite(o.ct)) prof.contentTopPt = o.ct;
    if (typeof o.ch === 'number' && Number.isFinite(o.ch)) prof.contentHeightPt = o.ch;
    if (Array.isArray(o.p)) {
      const pages = o.p
        .filter((x): x is [number, number, number, number] => Array.isArray(x) && x.length === 4 && x.every((n) => typeof n === 'number' && Number.isFinite(n)))
        .map(([s, h, ct, ch]) => ({ s, h, ct, ch }));
      // Every per-source-page height also feeds `new Array(h)` — one bad page invalidates the whole profile.
      if (pages.length) { if (pages.some((pg) => !validH(pg.h))) return null; prof.pages = pages; }
    }
    return prof;
  } catch {
    return null; // malformed -> treat as no profile (fixed bands)
  }
}

/** Map planBands content-px boundaries to source-pt boundaries, accounting for a stamp header/footer
 * band (contentTopPt/contentHeightPt). Falls back to whole-page mapping for band-less (old/no-stamp) PDFs. */
export function bandsToSourcePt(boundariesPx: number[], profile: BreakProfile, pageHeightPt: number): number[] {
  const contentTopPt = profile.contentTopPt ?? 0;
  const contentHeightPt = profile.contentHeightPt ?? pageHeightPt;
  const ptPerPx = profile.h > 0 ? contentHeightPt / profile.h : 1;
  return boundariesPx.map((px) => contentTopPt + px * ptPerPx);
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
