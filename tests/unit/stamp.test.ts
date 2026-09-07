import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { embedStampFonts, drawHeader, drawFooter, winAnsiSafe } from '../../src/renderer/stamp.js';

// Regression (operator 2026-09-03): a Greek page title crashed the WHOLE capture with
// "WinAnsi cannot encode "Υ" (0x03a5)" — the stamp's built-in Helvetica (WinAnsi) can't encode Greek,
// and both drawText AND widthOfTextAtSize throw. The stamp is an optional label; it must fold text down
// to WinAnsi (dropping unencodable glyphs) and never fail the capture.
describe('winAnsiSafe', () => {
  it('drops Greek and other non-WinAnsi glyphs', () => {
    expect(winAnsiSafe('Υλικά')).toBe(''); // all-Greek → nothing encodable
    expect(winAnsiSafe('Υ Guide')).toBe('Guide'); // mixed → keep the Latin, drop the Greek
    expect(winAnsiSafe('日本語 report')).toBe('report');
    expect(winAnsiSafe('emoji 🚀 here')).toBe('emoji here');
  });
  it('keeps ASCII, Latin-1, and cp1252 punctuation', () => {
    expect(winAnsiSafe('Résumé — "quotes" café €5')).toBe('Résumé — "quotes" café €5');
  });
  it('normalizes odd spaces (incl. the narrow no-break space some locales put in timestamps)', () => {
    expect(winAnsiSafe('3 Sept 2026')).toBe('3 Sept 2026');
  });
});

describe('stamp drawing never throws on non-WinAnsi text', () => {
  it('draws a Greek title + Greek-locale timestamp without crashing', async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedStampFonts(doc);
    const page = doc.addPage([600, 800]);
    // Before the fix these lines threw and failed the entire full-page capture.
    expect(() => drawHeader(page, fonts, 'Υλικά — Wind River Lesson', 24, 552, 780)).not.toThrow();
    expect(() =>
      drawFooter(page, fonts, { url: 'https://site/Υλικά?q=1', capturedAt: '3 Σεπτεμβρίου 2026, 5:12 μ.μ.' }, 1, 2, 24, 552, 12),
    ).not.toThrow();
    const bytes = await doc.save();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});
