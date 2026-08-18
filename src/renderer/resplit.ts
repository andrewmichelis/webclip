// Re-split a saved capture (typically an AUTO one-page PDF) into printable A4/Letter pages —
// a PDF -> PDF operation, no re-capture. Chrome's PDF viewer is not a scriptable/scrollable DOM,
// so the capture engine cannot re-shoot it; instead we load the file and slice each tall page into
// page-height bands with pdf-lib (embed the source page once, draw a clipped band per output page).
// WebClip AUTO captures carry a whitespace profile (see pdf-renderer), so the slices land on the
// SAME clean gaps as the direct paginated path; other PDFs fall back to fixed bands.
import { PDFDocument, pushGraphicsState, popGraphicsState, rectangle, clip, endPath } from 'pdf-lib';
import { PRODUCT_NAME, VERSION } from '../shared/constants.js';
import { parseBreakProfile, inkFromGaps, planBands } from '../shared/resplit-plan.js';

const MARGIN_PT = 18;
const TOP_EXTRA_PT = 14; // extra breathing room at the top of every page (keep in step with pdf-renderer)
const PAGE_PT: Record<'A4' | 'LETTER', [number, number]> = { A4: [595.28, 841.89], LETTER: [612, 792] };
const BREAK_LOOKBACK_FRACTION = 0.25; // keep in step with pdf-renderer
const ACTIVITY_BLANK_THRESHOLD = 2.5;

export type ResplitOrientation = 'portrait' | 'landscape';
export interface ResplitResult {
  bytes: Uint8Array;
  pageCount: number;
  smart: boolean; // true if a WebClip whitespace profile drove content-aware breaks
}

/**
 * Slice every page of `srcBytes` into `paperSize` pages (fit-to-width). Uses the source's embedded
 * WebClip whitespace profile for content-aware breaks when present (single-page captures), else
 * fixed page-height bands. Each output page draws the source page clipped to one band so nothing
 * bleeds into the margins.
 */
export async function resplitPdfToPrintable(
  srcBytes: Uint8Array,
  paperSize: 'A4' | 'LETTER',
  orientation: ResplitOrientation = 'portrait',
): Promise<ResplitResult> {
  const src = await PDFDocument.load(srcBytes);
  const profile = parseBreakProfile(src.getKeywords());
  const out = await PDFDocument.create();
  out.setProducer(`${PRODUCT_NAME} ${VERSION}`);
  out.setCreator(PRODUCT_NAME);
  const title = src.getTitle();
  if (title) out.setTitle(title);
  const subject = src.getSubject();
  if (subject) out.setSubject(subject);

  let [pw, ph] = PAGE_PT[paperSize];
  if (orientation === 'landscape') [pw, ph] = [ph, pw];
  const contentW = pw - 2 * MARGIN_PT;
  const contentH = ph - 2 * MARGIN_PT - TOP_EXTRA_PT; // extra breathing room at the top

  const srcPages = src.getPages();
  let pageCount = 0;
  let smart = false;
  const MAX_OUTPUT_PAGES = 2000; // guard against a pathological (very tall) source PDF fanning out

  for (let sp = 0; sp < srcPages.length; sp++) {
    const srcPage = srcPages[sp];
    const W = srcPage.getWidth();
    const H = srcPage.getHeight();
    if (W <= 0 || H <= 0) continue;
    const embedded = await out.embedPage(srcPage);
    const scale = contentW / W; // fit source width to the printable content width
    const bandSrcPt = contentH / scale; // source pt that fills one page's content height

    // Boundary offsets from the source top, in source pt (top-down).
    let boundsPt: number[];
    if (profile && srcPages.length === 1 && profile.h > 0) {
      const ptPerPx = H / profile.h;
      const pageContentPx = Math.max(1, Math.round(bandSrcPt / ptPerPx));
      const lookback = Math.max(8, Math.floor(pageContentPx * BREAK_LOOKBACK_FRACTION));
      const ink = inkFromGaps(profile.h, profile.gaps);
      boundsPt = planBands(profile.h, pageContentPx, lookback, ACTIVITY_BLANK_THRESHOLD, ink).map((px) => px * ptPerPx);
      smart = true;
    } else {
      boundsPt = [0];
      for (let b = bandSrcPt; b < H - 0.5; b += bandSrcPt) boundsPt.push(b);
      boundsPt.push(H);
    }

    if (pageCount + boundsPt.length > MAX_OUTPUT_PAGES) {
      throw new Error(`This PDF would split into over ${MAX_OUTPUT_PAGES} pages — too large to process.`);
    }
    for (let i = 0; i + 1 < boundsPt.length; i++) {
      const topSrc = boundsPt[i];
      const bandSrc = boundsPt[i + 1] - topSrc;
      if (bandSrc <= 0.5) continue;
      const drawH = bandSrc * scale; // height of this band on the printed page (<= contentH)
      const page = out.addPage([pw, ph]); // uniform full page (printable); content sits at the top
      const contentTop = ph - MARGIN_PT - TOP_EXTRA_PT;
      // Position the (full) embedded page so source band [topSrc, topSrc+bandSrc] sits at the content
      // top; clip to the content rectangle so the rest of the tall page never bleeds into the margins.
      const yBottom = contentTop - H * scale + topSrc * scale;
      page.pushOperators(
        pushGraphicsState(),
        rectangle(MARGIN_PT, contentTop - drawH, contentW, drawH),
        clip(),
        endPath(),
      );
      page.drawPage(embedded, { x: MARGIN_PT, y: yBottom, xScale: scale, yScale: scale });
      page.pushOperators(popGraphicsState());
      pageCount++;
    }
  }

  return { bytes: await out.save(), pageCount, smart };
}
