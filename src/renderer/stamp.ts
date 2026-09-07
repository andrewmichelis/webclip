// Optional page stamps: a header (title) on the first page and a footer (URL · capture time ·
// page N/M) on every page. Drawn with embedded standard fonts (no external assets). (A capture's
// SHA-256 checksum is Evidence Mode's separate, detached sidecar — see BASELINE ARCH-WC-10 — never
// baked into the PDF itself, which a file cannot contain.)
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

// The stamp fonts are the built-in Helvetica (WinAnsi) — no external font asset (ARCH-WC-04). WinAnsi
// can't encode Greek/CJK/emoji, and BOTH drawText and widthOfTextAtSize THROW on an unencodable glyph,
// which would fail the whole capture over an optional label (e.g. a Greek page title, or a locale
// timestamp carrying a narrow no-break space). So fold every stamp string down to WinAnsi: normalize odd
// spaces, keep only cp1252-representable characters, drop the rest. The capture IMAGE keeps the real
// glyphs (it's pixel-faithful); only the metadata strip is folded. (Escapes only — no literal non-ASCII
// in the class, so the source can't silently mangle a code point.)
const ODD_SPACES = /[       ]/g; // no-break / thin / figure spaces
const WINANSI_DROP =
  /[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜]/g;
export function winAnsiSafe(s: string): string {
  return s.replace(ODD_SPACES, ' ').normalize('NFC').replace(WINANSI_DROP, '').replace(/\s{2,}/g, ' ').trim();
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
  try {
    const safe = winAnsiSafe(title);
    if (!safe) return; // title was entirely unencodable (e.g. all-Greek) → skip the header, never crash
    const text = fit(fonts.bold, safe, HEADER_SIZE, width);
    const w = fonts.bold.widthOfTextAtSize(text, HEADER_SIZE);
    page.drawText(text, { x: xLeft + (width - w) / 2, y: baselineY, size: HEADER_SIZE, font: fonts.bold, color: INK });
  } catch {
    /* an optional label must never fail the capture */
  }
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
  try {
    const rightParts: string[] = [];
    if (data.capturedAt) rightParts.push(`captured ${winAnsiSafe(data.capturedAt)}`);
    rightParts.push(`p ${pageNo}/${pageCount}`);
    const right = rightParts.join('  ·  ');
    const rightW = fonts.regular.widthOfTextAtSize(right, FOOTER_SIZE);
    page.drawText(right, { x: xLeft + width - rightW, y: baselineY, size: FOOTER_SIZE, font: fonts.regular, color: MUTED });

    if (data.url) {
      const safeUrl = winAnsiSafe(data.url);
      const gap = 12;
      const urlMax = width - rightW - gap;
      if (safeUrl && urlMax > 24) {
        const url = fit(fonts.regular, safeUrl, FOOTER_SIZE, urlMax);
        page.drawText(url, { x: xLeft, y: baselineY, size: FOOTER_SIZE, font: fonts.regular, color: MUTED });
      }
    }
  } catch {
    /* an optional label must never fail the capture */
  }
}
