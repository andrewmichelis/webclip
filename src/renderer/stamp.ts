// Optional page stamps: a header (title) on the first page and a footer (URL · capture time ·
// SHA-256 · page N/M) on every page. Drawn with embedded standard fonts (no external assets).
// The SHA is of the CAPTURED IMAGE bytes (honest, non-circular) — NOT the PDF's own hash, which a
// file cannot contain (see Evidence Mode's detached sidecar).
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';

export const HEADER_BAND_PT = 30; // reserved header strip for AUTO one-page (no natural margins)
export const FOOTER_BAND_PT = 20; // reserved footer strip for AUTO one-page
const HEADER_SIZE = 11;
const FOOTER_SIZE = 7.5;
const INK = rgb(0.15, 0.15, 0.17);
const MUTED = rgb(0.42, 0.45, 0.5);

export interface StampFonts {
  regular: PDFFont;
  bold: PDFFont;
}
export interface StampData {
  title?: string;
  url?: string;
  capturedAt?: string; // human-readable local timestamp
}

export async function embedStampFonts(doc: PDFDocument): Promise<StampFonts> {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
}

/** Truncate `text` with an ellipsis so it fits within `maxWidth` at `size`. */
function fit(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && font.widthOfTextAtSize(s + '…', size) > maxWidth) s = s.slice(0, -1);
  return s + '…';
}

/** Draw the title header centered on its baseline row, within [xLeft, xLeft+width]. */
export function drawHeader(page: PDFPage, fonts: StampFonts, title: string, xLeft: number, width: number, baselineY: number): void {
  const text = fit(fonts.bold, title, HEADER_SIZE, width);
  const w = fonts.bold.widthOfTextAtSize(text, HEADER_SIZE);
  page.drawText(text, { x: xLeft + (width - w) / 2, y: baselineY, size: HEADER_SIZE, font: fonts.bold, color: INK });
}

/**
 * Draw the footer: URL on the left, "captured … · p N/M" on the right, both within [xLeft, xLeft+width].
 * The URL is truncated to whatever space the right block leaves.
 */
export function drawFooter(
  page: PDFPage,
  fonts: StampFonts,
  data: StampData,
  pageNo: number,
  pageCount: number,
  xLeft: number,
  width: number,
  baselineY: number,
): void {
  const rightParts: string[] = [];
  if (data.capturedAt) rightParts.push(`captured ${data.capturedAt}`);
  rightParts.push(`p ${pageNo}/${pageCount}`);
  const right = rightParts.join('  ·  ');
  const rightW = fonts.regular.widthOfTextAtSize(right, FOOTER_SIZE);
  page.drawText(right, { x: xLeft + width - rightW, y: baselineY, size: FOOTER_SIZE, font: fonts.regular, color: MUTED });

  if (data.url) {
    const gap = 12;
    const urlMax = width - rightW - gap;
    if (urlMax > 24) {
      const url = fit(fonts.regular, data.url, FOOTER_SIZE, urlMax);
      page.drawText(url, { x: xLeft, y: baselineY, size: FOOTER_SIZE, font: fonts.regular, color: MUTED });
    }
  }
}
