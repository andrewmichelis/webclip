#!/usr/bin/env node
// verify-pdf.mjs — deterministic checks on a WebClip PDF, no model + no operator in the loop (SE-28).
// Automates the pixel/structure checks that were being done by hand:
//   • structural: loads, page count, uniform page sizes for printable output
//   • break quality (--breaks): every interior page boundary lands on whitespace (needs `pdftoppm`)
//   • links: annotation count + every /URI is a delimiter-proof HEX string (locks the T-1 fix)
//   • security: no /JavaScript, /Launch, /SubmitForm, or /GoToR actions leaked into the PDF
//
// Usage:  node scripts/verify-pdf.mjs <file.pdf> [--breaks] [--min-pages N] [--expect-links]
// Exit 0 = all checks pass; exit 1 = a check failed (CI-friendly).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRawStream } from 'pdf-lib';
import { inflateSync } from 'node:zlib';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k) => args.includes(`--${k}`);
const val = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
if (!file) {
  console.error('usage: node scripts/verify-pdf.mjs <file.pdf> [--breaks] [--min-pages N] [--expect-links] [--expect-uri SUBSTR] [--expect-text SUBSTR] [--expect-dark-bottom]...');
  process.exit(2);
}
// Every value passed after a repeated flag (e.g. --expect-uri A --expect-uri B).
const vals = (k) => args.reduce((acc, a, i) => (a === `--${k}` && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
const expectUris = vals('expect-uri');
const forbidUris = vals('expect-no-uri');
const expectTexts = vals('expect-text');

const fails = [];
const notes = [];
const check = (cond, msg) => (cond ? notes.push(`  ok   ${msg}`) : fails.push(`  FAIL ${msg}`));

const bytes = readFileSync(file);
const raw = bytes.toString('latin1');
const doc = await PDFDocument.load(bytes);
const pages = doc.getPages();
const n = pages.length;
notes.push(`PDF: ${file}  (${bytes.length} bytes, ${n} pages)`);

// --- structural ---
check(n >= Number(val('min-pages', 1)), `page count ${n} >= ${val('min-pages', 1)}`);
if (opt('min-height')) {
  const tallest = Math.max(...pages.map((p) => p.getHeight()));
  const want = Number(val('min-height', 0));
  check(tallest >= want, `tallest page ${tallest.toFixed(0)}pt >= ${want}pt (multi-shot stitch assembled)`);
}
if (opt('max-height')) {
  const tallest = Math.max(...pages.map((p) => p.getHeight()));
  const want = Number(val('max-height', 0));
  check(tallest <= want, `tallest page ${tallest.toFixed(0)}pt <= ${want}pt (patched in place — no duplicated / undeduped overlap)`);
}
// --- feature assertions (opt-in): orientation, paper size, image format, links off ---
const tallest = pages.reduce((a, p) => (p.getHeight() > a.getHeight() ? p : a), pages[0]);
if (opt('landscape')) check(tallest.getWidth() > tallest.getHeight(), `pages are landscape (w ${tallest.getWidth().toFixed(0)} > h ${tallest.getHeight().toFixed(0)})`);
if (opt('portrait')) check(tallest.getHeight() >= tallest.getWidth(), `pages are portrait (h ${tallest.getHeight().toFixed(0)} >= w ${tallest.getWidth().toFixed(0)})`);
if (val('paper', null)) {
  const want = val('paper', 'A4').toUpperCase();
  const dims = { A4: [595.28, 841.89], LETTER: [612, 792] }[want];
  if (dims) {
    const w = pages[0].getWidth(), h = pages[0].getHeight();
    const match = (Math.abs(w - dims[0]) < 2 && Math.abs(h - dims[1]) < 2) || (Math.abs(w - dims[1]) < 2 && Math.abs(h - dims[0]) < 2);
    check(match, `page 1 is ${want} size (${w.toFixed(0)}x${h.toFixed(0)}pt vs ${dims[0]}x${dims[1]})`);
  }
}
if (opt('jpeg')) check(/\/DCTDecode/.test(raw), `PDF embeds JPEG image data (/DCTDecode present)`);
if (opt('no-links')) { /* asserted below once annotTotal is counted */ }
const sizes = pages.map((p) => `${p.getWidth().toFixed(0)}x${p.getHeight().toFixed(0)}`);
if (n > 2) {
  // printable output should be uniform (one-tall is a single page and is skipped)
  const body = sizes.slice(0, -1); // last page may be shorter
  const uniform = body.every((s) => s === body[0]);
  check(uniform, `interior pages are uniform size (${body[0]})`);
}

// --- links + security (structural, always) ---
let annotTotal = 0;
let hexUris = 0;
let literalUris = 0;
let unclickableUris = 0; // hex URI that a viewer cannot parse (UTF-16 BOM) or with a bad scheme
const sampleUris = [];
const decodedUris = []; // every clickable /URI text, for --expect-uri content assertions
// Decode a /URI hex string to the exact bytes a viewer reads. A leading UTF-16 BOM (FEFF) means the
// URL was written with PDFHexString.fromText and is NOT clickable — the regression this now catches.
function decodeUri(hex) {
  const digits = hex.toString().replace(/[<>\s]/g, '');
  const bytes = Buffer.from(digits, 'hex');
  return { bom: bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff, text: bytes.toString('utf8') };
}
// Inspect the PARSED annotation objects (robust to object-stream compression): every link /URI must be
// a HEX string (delimiter-proof, T-1) AND decode to a plain, clickable URL (no UTF-16 BOM, allowed scheme).
for (const p of pages) {
  const annots = p.node.get(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) continue;
  for (let i = 0; i < annots.size(); i++) {
    const a = doc.context.lookup(annots.get(i));
    if (!(a instanceof PDFDict)) continue;
    if (a.get(PDFName.of('Subtype'))?.toString() !== '/Link') continue;
    annotTotal++;
    const action = doc.context.lookup(a.get(PDFName.of('A')));
    if (action instanceof PDFDict) {
      const uri = doc.context.lookup(action.get(PDFName.of('URI'))) ?? action.get(PDFName.of('URI'));
      if (uri instanceof PDFHexString) {
        hexUris++;
        const { bom, text } = decodeUri(uri);
        const clickable = !bom && /^(https?|mailto|tel):/i.test(text);
        if (clickable) decodedUris.push(text);
        if (!clickable) {
          unclickableUris++;
          notes.push(`  ✗ unclickable /URI: ${bom ? '[UTF-16 BOM] ' : ''}${JSON.stringify(text.slice(0, 60))}`);
        }
        if (sampleUris.length < 3) sampleUris.push(text.slice(0, 60));
      } else if (uri instanceof PDFString) {
        literalUris++;
      }
    }
  }
}
if (opt('expect-links')) check(annotTotal > 0, `has link annotations (${annotTotal})`);
if (opt('no-links')) check(annotTotal === 0, `no link annotations when links disabled (found ${annotTotal})`);
for (const want of expectUris) check(decodedUris.some((u) => u.includes(want)), `has a link /URI containing "${want}"`);
for (const bad of forbidUris) check(!decodedUris.some((u) => u.includes(bad)), `no link /URI containing "${bad}"`);
notes.push(`  info link annotations: ${annotTotal}  (URI hex: ${hexUris}, literal: ${literalUris})`);
if (sampleUris.length) notes.push(`  info sample URIs: ${sampleUris.map((u) => JSON.stringify(u)).join(', ')}`);
check(literalUris === 0, `no literal-string /URI ( … ) — T-1 injection surface (found ${literalUris})`);
check(unclickableUris === 0, `every /URI decodes to a clickable URL — no UTF-16 BOM / bad scheme (found ${unclickableUris})`);
const dangerous = ['/JavaScript', '/Launch', '/SubmitForm', '/GoToR', '/RichMedia'].filter((k) => raw.includes(k));
check(dangerous.length === 0, `no dangerous PDF actions leaked (${dangerous.join(', ') || 'none'})`);

// --- drawn text (opt-in): scan uncompressed content + every FlateDecode stream for a literal substring.
// Used to assert the optional page STAMP (footer "captured … · p N/M", header title) is actually drawn.
if (expectTexts.length) {
  let corpus = raw; // pdf-lib writes content streams uncompressed → text is already in `raw`
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const filter = obj.dict.get(PDFName.of('Filter'));
    if (!filter || !filter.toString().includes('FlateDecode')) continue;
    try { corpus += Buffer.from(inflateSync(Buffer.from(obj.contents))).toString('latin1'); } catch { /* skip */ }
  }
  // Drawn text may be a literal (...) string OR a hex <...> string — pdf-lib encodes StandardFont text as
  // hex (WinAnsi). Match either: the hex form is the wanted bytes, contiguous, inside the hex Tj operand.
  const lower = corpus.toLowerCase();
  const hexOf = (t) => Buffer.from(t, 'latin1').toString('hex');
  for (const want of expectTexts) check(corpus.includes(want) || lower.includes(hexOf(want)), `PDF text contains "${want}" (page stamp present)`);
}

// --- break quality (opt-in; needs pdftoppm) ---
if (opt('breaks') && n > 1) {
  let toppm = true;
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
  } catch {
    toppm = false;
    fails.push('  FAIL --breaks requested but `pdftoppm` (poppler-utils) not installed');
  }
  if (toppm) {
    const { readdirSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/webclip-verify-');
    execFileSync('pdftoppm', ['-gray', '-r', '110', file, dir + '/pg'], { stdio: 'ignore' });
    const pgs = readdirSync(dir).filter((f) => f.endsWith('.pgm')).sort();
    const rowAct = (d, W, y) => {
      let s = 0, prev = -1;
      for (let x = 0; x < W; x += 2) { const v = d[y * W + x]; if (prev >= 0) s += Math.abs(v - prev); prev = v; }
      return s / (W / 2);
    };
    let bad = 0;
    for (let idx = 0; idx < pgs.length; idx++) {
      const buf = readFileSync(dir + '/' + pgs[idx]);
      let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[p]))) p++; let t = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) t += String.fromCharCode(buf[p++]); return t; };
      tok(); const W = +tok(), H = +tok(); tok(); p++; const data = buf.subarray(p);
      const bandMax = (y0, y1) => { let m = 0; for (let y = y0; y < y1; y++) m = Math.max(m, rowAct(data, W, y)); return m; };
      // interior boundaries must be clean: bottom of every page but the last, top of every page but the first
      const top = idx > 0 ? bandMax(0, 6) : 0;
      const bottom = idx < pgs.length - 1 ? bandMax(H - 6, H) : 0;
      if (top > 6 || bottom > 6) { bad++; notes.push(`  info page ${idx + 1}: edge activity top=${top.toFixed(1)} bottom=${bottom.toFixed(1)}`); }
    }
    execFileSync('rm', ['-rf', dir]);
    check(bad === 0, `every interior page boundary lands on whitespace (${bad} suspect)`);
  }
}

// --- mark-region bottom capture (opt-in; needs pdftoppm): the very bottom band of page 1 must contain
// the dark section-bottom marker. If the last tile was placed at the assumed Y (clamp bug), the bottom
// is clipped/blank and this fails. ---
if (opt('expect-dark-bottom')) {
  let toppm = true;
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { toppm = false; fails.push('  FAIL --expect-dark-bottom needs `pdftoppm`'); }
  if (toppm) {
    const { readdirSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/webclip-darkbottom-');
    execFileSync('pdftoppm', ['-gray', '-r', '80', '-f', '1', '-l', '1', file, dir + '/pg'], { stdio: 'ignore' });
    const pgm = readdirSync(dir).filter((f) => f.endsWith('.pgm')).sort()[0];
    const buf = readFileSync(dir + '/' + pgm);
    let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[p]))) p++; let t = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) t += String.fromCharCode(buf[p++]); return t; };
    tok(); const W = +tok(), H = +tok(); tok(); p++; const data = buf.subarray(p);
    // fraction of dark pixels in the bottom 24px band
    let dark = 0, tot = 0;
    for (let y = Math.max(0, H - 24); y < H; y++) for (let x = 0; x < W; x += 2) { if (data[y * W + x] < 90) dark++; tot++; }
    const frac = tot > 0 ? dark / tot : 0;
    execFileSync('rm', ['-rf', dir]);
    check(frac > 0.3, `section bottom marker present in the output (${(frac * 100).toFixed(0)}% dark in the bottom band; clip/duplication bug would blank it)`);
  }
}

// --- vertical colour order (opt-in; needs pdftoppm): the given hex colours must appear as full-width
// bands top-to-bottom IN THE GIVEN ORDER on page 1. Proves atlas splice ORDER — e.g. a base widget's
// default tab (red) must sit ABOVE the marked tabs (green, blue), not below them. ---
const colorOrder = vals('expect-color-order'); // repeatable: --expect-color-order RRGGBB (in wanted order)
if (colorOrder.length) {
  let toppm = true;
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { toppm = false; fails.push('  FAIL --expect-color-order needs `pdftoppm`'); }
  if (toppm) {
    const { readdirSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/webclip-colororder-');
    execFileSync('pdftoppm', ['-r', '80', '-f', '1', '-l', '1', file, dir + '/pg'], { stdio: 'ignore' }); // colour PPM (P6)
    const ppm = readdirSync(dir).filter((f) => f.endsWith('.ppm')).sort()[0];
    const buf = readFileSync(dir + '/' + ppm);
    let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[p]))) p++; let t = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) t += String.fromCharCode(buf[p++]); return t; };
    const magic = tok(); const W = +tok(), H = +tok(); tok(); p++; const data = buf.subarray(p); // P6: W H maxval, then RGB bytes
    const hexToRgb = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };
    // topmost row where >=10% of sampled pixels are within tolerance of the target colour (a full-width band)
    const topRowOf = ([tr, tg, tb]) => {
      for (let y = 0; y < H; y++) {
        let hit = 0, tot = 0;
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 3;
          if (Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) + Math.abs(data[i + 2] - tb) < 90) hit++;
          tot++;
        }
        if (tot > 0 && hit / tot >= 0.1) return y;
      }
      return -1;
    };
    const rows = colorOrder.map((h) => ({ h, y: magic === 'P6' ? topRowOf(hexToRgb(h)) : -1 }));
    execFileSync('rm', ['-rf', dir]);
    const missing = rows.filter((r) => r.y < 0).map((r) => r.h);
    let ordered = missing.length === 0;
    for (let i = 1; i < rows.length && ordered; i++) if (!(rows[i].y > rows[i - 1].y)) ordered = false;
    check(ordered, `colours appear top-to-bottom in order [${colorOrder.join(', ')}] (rows ${rows.map((r) => r.y).join(' < ')}${missing.length ? '; missing ' + missing.join(',') : ''})`);
  }
}

// --- forbidden colour (opt-in; needs pdftoppm): the given hex colour must NOT appear as a band anywhere
// on page 1. Proves our own floating toolbar (distinctive button greens) is never baked into a capture. ---
const forbidColors = vals('forbid-color');
if (forbidColors.length) {
  let toppm = true;
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { toppm = false; fails.push('  FAIL --forbid-color needs `pdftoppm`'); }
  if (toppm) {
    const { readdirSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/webclip-forbid-');
    execFileSync('pdftoppm', ['-r', '80', '-f', '1', '-l', '1', file, dir + '/pg'], { stdio: 'ignore' });
    const ppm = readdirSync(dir).filter((f) => f.endsWith('.ppm')).sort()[0];
    const buf = readFileSync(dir + '/' + ppm);
    let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[p]))) p++; let t = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) t += String.fromCharCode(buf[p++]); return t; };
    const magic = tok(); const W = +tok(), H = +tok(); tok(); p++; const data = buf.subarray(p);
    const hexToRgb = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };
    const present = ([tr, tg, tb]) => {
      if (magic !== 'P6') return false;
      let hit = 0, tot = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x += 2) {
        const i = (y * W + x) * 3;
        if (Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) + Math.abs(data[i + 2] - tb) < 60) hit++;
        tot++;
      }
      return tot > 0 && hit / tot >= 0.004; // even a small toolbar covers >0.4% of the page
    };
    execFileSync('rm', ['-rf', dir]);
    for (const h of forbidColors) check(!present(hexToRgb(h)), `forbidden colour #${h} is absent (our own toolbar/UI not baked into the capture)`);
  }
}

// --- colour band COUNT (opt-in; needs pdftoppm): a colour must appear in at most N distinct horizontal
// bands on page 1. Proves a FROZEN/repeated header (identical top band baked into every tile) is collapsed
// to a single occurrence instead of repeating down the capture. Format: --max-color-bands RRGGBB:N ---
const bandLimits = vals('max-color-bands'); // each token "RRGGBB:N"
if (bandLimits.length || vals('min-color-rows').length || vals('max-color-rows').length) {
  let toppm = true;
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); } catch { toppm = false; fails.push('  FAIL --max-color-bands/--min-color-rows needs `pdftoppm`'); }
  if (toppm) {
    const { readdirSync, mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync('/tmp/webclip-bands-');
    execFileSync('pdftoppm', ['-r', '80', '-f', '1', '-l', '1', file, dir + '/pg'], { stdio: 'ignore' });
    const ppm = readdirSync(dir).filter((f) => f.endsWith('.ppm')).sort()[0];
    const buf = readFileSync(dir + '/' + ppm);
    let p = 0; const tok = () => { while (/\s/.test(String.fromCharCode(buf[p]))) p++; let t = ''; while (!/\s/.test(String.fromCharCode(buf[p]))) t += String.fromCharCode(buf[p++]); return t; };
    const magic = tok(); const W = +tok(), H = +tok(); tok(); p++; const data = buf.subarray(p);
    const hexToRgb = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]; };
    const rowHasColor = (y, [tr, tg, tb]) => {
      let hit = 0, tot = 0;
      for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 3; if (Math.abs(data[i] - tr) + Math.abs(data[i + 1] - tg) + Math.abs(data[i + 2] - tb) < 60) hit++; tot++; }
      return tot > 0 && hit / tot >= 0.2; // a full-width header row is ~100%; content rows are ~0
    };
    const countBands = (rgb) => {
      let bands = 0, inBand = false, gap = 0;
      for (let y = 0; y < H; y++) {
        if (rowHasColor(y, rgb)) { if (!inBand) { bands++; inBand = true; } gap = 0; }
        else if (inBand && ++gap >= 3) { inBand = false; } // a few blank rows close the band (antialias-safe)
      }
      return bands;
    };
    // total rows (at r=80) where the colour is present — catches a GAP that ate part of a block (too few rows)
    const countRows = (rgb) => { let n = 0; for (let y = 0; y < H; y++) if (rowHasColor(y, rgb)) n++; return n; };
    execFileSync('rm', ['-rf', dir]);
    if (magic !== 'P6') { fails.push('  FAIL --max-color-bands: page render was not P6'); }
    else {
      for (const spec of bandLimits) {
        const [h, n] = spec.split(':');
        const c = countBands(hexToRgb(h));
        check(c <= +n, `colour #${h} appears in <= ${n} band(s) — a frozen/repeated header collapsed to one (found ${c})`);
      }
      // --min-color-rows RRGGBB:N — the colour must span at least N rows (its block wasn't eaten by a gap
      // hidden behind a frozen header). Pairs with --max-color-bands to prove content is complete AND not
      // duplicated. Rendered at r=80.
      for (const spec of vals('min-color-rows')) {
        const [h, n] = spec.split(':');
        const rows = countRows(hexToRgb(h));
        check(rows >= +n, `colour #${h} spans >= ${n} rows — its block survived (no content lost behind a header); found ${rows}`);
      }
      // --max-color-rows RRGGBB:N — the colour spans at most N rows (its block isn't DUPLICATED, e.g. a
      // partial mark stacked on top of the full one). Pairs with --min-color-rows to bracket a block's height.
      for (const spec of vals('max-color-rows')) {
        const [h, n] = spec.split(':');
        const rows = countRows(hexToRgb(h));
        check(rows <= +n, `colour #${h} spans <= ${n} rows — its block isn't duplicated; found ${rows}`);
      }
    }
  }
}

// --- report ---
console.log(notes.join('\n'));
if (fails.length) {
  console.log('\n' + fails.join('\n'));
  console.log(`\nRESULT: FAIL (${fails.length})`);
  process.exit(1);
}
console.log('\nRESULT: PASS');
