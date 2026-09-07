import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFHexString } from 'pdf-lib';
import {
  renderImageToPdfBytes,
  pageContentGeometry,
  linkRectForPage,
  sanitizeLinkUrl,
  pdfUriHexString,
  detectBackground,
  frozenBandBackground,
} from '../../src/renderer/pdf-renderer.js';

const here = dirname(fileURLToPath(import.meta.url));
const png = new Uint8Array(readFileSync(resolve(here, '../../src/assets/icons/icon-128.png'))); // 128x128 square

/** Decode a PDF hex string (`<..>`) back to the UTF-8 text it encodes — what a viewer reads as the URI. */
function decodeHexString(hex: PDFHexString): string {
  const digits = hex.toString().replace(/[<>\s]/g, '');
  const bytes = new Uint8Array(digits.match(/../g)!.map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

describe('renderImageToPdfBytes', () => {
  it('renders a single-page A4 PDF from a PNG', async () => {
    const bytes = await renderImageToPdfBytes({ bytes: png, format: 'png' }, { paperSize: 'A4', orientation: 'auto' });
    expect(bytes.length).toBeGreaterThan(100);
    expect(String.fromCharCode(...bytes.subarray(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getWidth()).toBeCloseTo(595.28, 1); // A4 portrait width in pt
  });

  it('AUTO paper produces a page matching the image aspect ratio', async () => {
    const bytes = await renderImageToPdfBytes({ bytes: png, format: 'png' }, { paperSize: 'AUTO', orientation: 'auto' });
    const page = (await PDFDocument.load(bytes)).getPage(0);
    expect(page.getWidth()).toBeCloseTo(page.getHeight(), 1); // square image -> square page
  });
});

describe('pageContentGeometry', () => {
  it('sanitizeLinkUrl allows safe schemes and rejects dangerous / malformed ones (T-1 sink)', () => {
    expect(sanitizeLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(sanitizeLinkUrl('  http://x.io  ')).toBe('http://x.io'); // trimmed
    expect(sanitizeLinkUrl('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(sanitizeLinkUrl('tel:+301234')).toBe('tel:+301234');
    // rejects non-allowlisted schemes and junk
    expect(sanitizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeLinkUrl('data:text/html,x')).toBeNull();
    expect(sanitizeLinkUrl('')).toBeNull();
    expect(sanitizeLinkUrl('https://' + 'a'.repeat(3000))).toBeNull(); // over length cap
    // the injection payload is an allowed scheme; hex-encoding at the sink neutralizes the () breakout,
    // and it still passes sanitize (which only gates scheme/length) — the safety is the PDFHexString sink.
    expect(sanitizeLinkUrl('https://x.test/a)/S/JavaScript/JS(app.alert(1))(')).toContain('https://');
  });

  it('maps a link onto a page with the PDF y-flip', () => {
    // content link at rows [100,140) px, page content [0,1000) px, content-top at 800pt, scale 0.5pt/px
    const r = linkRectForPage({ top: 100, left: 40, w: 60, h: 40, url: 'https://x' }, 0, 1000, 800, 18, 0.5);
    expect(r).not.toBeNull();
    expect(r!.y2).toBeCloseTo(800 - 100 * 0.5, 5); // top of link (higher y)
    expect(r!.y1).toBeCloseTo(800 - 140 * 0.5, 5); // bottom of link (lower y)
    expect(r!.x1).toBeCloseTo(18 + 40 * 0.5, 5);
    expect(r!.x2).toBeCloseTo(18 + 100 * 0.5, 5);
    expect(r!.url).toBe('https://x');
  });

  it('clips a link to the page it lands on and drops non-overlapping links', () => {
    // link spans content [980,1040); page 1 covers [0,1000) -> clipped to [980,1000)
    const p1 = linkRectForPage({ top: 980, left: 0, w: 10, h: 60, url: 'u' }, 0, 1000, 800, 0, 1);
    expect(p1!.y2).toBeCloseTo(800 - (980 - 0), 5);
    expect(p1!.y1).toBeCloseTo(800 - (1000 - 0), 5); // clipped at the page boundary (1000)
    // page 2 covers [1000,2000) -> the same link, remainder [1000,1040), mapped from that page's top
    const p2 = linkRectForPage({ top: 980, left: 0, w: 10, h: 60, url: 'u' }, 1000, 2000, 800, 0, 1);
    expect(p2!.y2).toBeCloseTo(800 - 0, 5); // starts at page-2 content top
    // a link entirely above the page range -> null
    expect(linkRectForPage({ top: 10, left: 0, w: 10, h: 10, url: 'u' }, 1000, 2000, 800, 0, 1)).toBeNull();
  });

  it('computes fit-to-width geometry for A4 portrait', () => {
    const g = pageContentGeometry('A4', 'auto', 1000);
    expect(g.pageWpt).toBeCloseTo(595.28, 1);
    expect(g.pageHpt).toBeCloseTo(841.89, 1);
    expect(g.contentWidthPt).toBeCloseTo(559.28, 1);
    expect(g.scalePtPerPx).toBeCloseTo(0.55928, 4);
    expect(g.pageContentHeightPx).toBe(1440);
  });
  it('swaps dimensions for landscape', () => {
    const g = pageContentGeometry('A4', 'landscape', 1000);
    expect(g.pageWpt).toBeCloseTo(841.89, 1);
    expect(g.pageHpt).toBeCloseTo(595.28, 1);
  });
});

// Regression guard for the "links not clickable" bug: the /URI must be a delimiter-proof HEX string
// (T-1) AND decode to the plain URL bytes (clickable). PDFHexString.fromText emits UTF-16BE with a
// FEFF BOM that viewers won't parse as a URI — these tests fail loudly if that form ever returns.
describe('clickable link annotations (T-1 safe + viewer-parseable)', () => {
  const urls = [
    'https://example.com/a?b=1&c=2',
    'https://en.wikipedia.org/wiki/Foo_(disambiguation)', // legitimately contains ( )
    'mailto:hello@knackmentor.com',
    'https://x.test/a)/S/JavaScript/JS(app.alert(1))(', // T-1 injection payload, must survive verbatim
  ];

  it('pdfUriHexString round-trips to the exact URL with no UTF-16 BOM', () => {
    for (const url of urls) {
      const hex = pdfUriHexString(url);
      expect(hex).toBeInstanceOf(PDFHexString);
      const raw = hex.toString(); // "<..hex..>"
      expect(raw.toLowerCase().startsWith('<feff')).toBe(false); // NOT UTF-16BE (the regression)
      expect(decodeHexString(hex)).toBe(url); // viewer reads back the exact URL
      // hex digits only -> no (, ), or \ can appear -> cannot break out of the PDF string (T-1)
      expect(raw.slice(1, -1)).toMatch(/^[0-9a-fA-F]*$/);
    }
  });

  // Note: the full renderFullPagePdf path needs createImageBitmap (browser-only), so the wired
  // annotation is exercised end-to-end by the headless harness (scripts/harness.mjs) + verify-pdf,
  // which now decode every /URI and fail on a UTF-16 BOM or bad scheme. Here we lock the encoder.
});

// Regression guard (operator 2026-09-06, Wind River "Introducing Zephyr Essentials" default full-page PDF —
// "the same problem everywhere"): the frozen-band background estimate mis-read a light page as dark and
// mis-detected a FROZEN FOOTER, whose skipBottom collapsed every seam's overlap → content doubled at each fold.
// Root: a light page background spread across several near-white shades splits into several /8 buckets, EACH
// smaller than one solid dark hero/CTA block, so the dark block wins the vote even over the whole tile. Fix:
// frozenBandBackground quantizes COARSELY (/32, bucket-centred) so the near-white shades merge into the light
// majority. Teeth: build exactly that pixel mix and assert the naive /8 estimate reads a near-white pixel as
// INK (the false footer) while frozenBandBackground reads it as background. Revert the mask to /8 → this fails.
describe('frozenBandBackground (dark-hero false-footer root)', () => {
  const W = 64, H = 64;
  // A tile-0-like region: 37% solid dark hero (a plurality), 63% light background split across FOUR near-white
  // shades — each in a different /8 bucket (0xe0/0xe8/0xf0/0xf8) but all inside ONE /32 bucket (0xe0).
  const buf = new Uint8ClampedArray(W * H * 4);
  const shades = [0x26 /* dark hero */, 0xe4, 0xec, 0xf4, 0xfc];
  for (let y = 0; y < H; y++) {
    // rows 0..23 dark (24/64 ≈ 37%); rows 24..63 cycle the four light shades (10 rows each ≈ 63% total)
    const v = y < 24 ? shades[0] : shades[1 + (Math.floor((y - 24) / 10) % 4)];
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; buf[o] = buf[o + 1] = buf[o + 2] = v; buf[o + 3] = 255; }
  }
  const inkAgainst = (bg: number[], c = 245): boolean => Math.abs(c - bg[0]) + Math.abs(c - bg[1]) + Math.abs(c - bg[2]) > 50;

  it('the naive /8 estimate is fooled: the dark hero out-votes the fragmented light background', () => {
    const bg8 = detectBackground(buf, W, H); // default /8 — the pre-fix behaviour
    expect(bg8[0]).toBeLessThan(64); // picks the dark hero
    expect(inkAgainst(bg8)).toBe(true); // → a near-white (245) pixel reads as INK → false frozen footer
  });

  it('frozenBandBackground merges the shades to the true light majority (no false footer)', () => {
    const bg = frozenBandBackground(buf, W, H);
    expect(bg[0]).toBeGreaterThanOrEqual(224); // light background wins
    expect(inkAgainst(bg)).toBe(false); // → a near-white (245) pixel is background, not ink → footerH = 0
  });
});
