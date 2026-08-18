#!/usr/bin/env node
// verify-pdf.mjs — deterministic, fully automated checks on a WebClip PDF.
// Automates the pixel/structure checks that were being done by hand:
//   • structural: loads, page count, uniform page sizes for printable output
//   • break quality (--breaks): every interior page boundary lands on whitespace (needs `pdftoppm`)
//   • links: annotation count + every /URI is a delimiter-proof HEX string (injection-safe)
//   • security: no /JavaScript, /Launch, /SubmitForm, or /GoToR actions leaked into the PDF
//
// Usage:  node scripts/verify-pdf.mjs <file.pdf> [--breaks] [--min-pages N] [--expect-links]
// Exit 0 = all checks pass; exit 1 = a check failed (CI-friendly).
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString } from 'pdf-lib';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k) => args.includes(`--${k}`);
const val = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
if (!file) {
  console.error('usage: node scripts/verify-pdf.mjs <file.pdf> [--breaks] [--min-pages N] [--expect-links]');
  process.exit(2);
}

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
// Decode a /URI hex string to the exact bytes a viewer reads. A leading UTF-16 BOM (FEFF) means the
// URL was written with PDFHexString.fromText and is NOT clickable — the regression this now catches.
function decodeUri(hex) {
  const digits = hex.toString().replace(/[<>\s]/g, '');
  const bytes = Buffer.from(digits, 'hex');
  return { bom: bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff, text: bytes.toString('utf8') };
}
// Inspect the PARSED annotation objects (robust to object-stream compression): every link /URI must be
// a HEX string (delimiter-proof) AND decode to a plain, clickable URL (no UTF-16 BOM, allowed scheme).
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
notes.push(`  info link annotations: ${annotTotal}  (URI hex: ${hexUris}, literal: ${literalUris})`);
if (sampleUris.length) notes.push(`  info sample URIs: ${sampleUris.map((u) => JSON.stringify(u)).join(', ')}`);
check(literalUris === 0, `no literal-string /URI ( … ) — injection surface (found ${literalUris})`);
check(unclickableUris === 0, `every /URI decodes to a clickable URL — no UTF-16 BOM / bad scheme (found ${unclickableUris})`);
const dangerous = ['/JavaScript', '/Launch', '/SubmitForm', '/GoToR', '/RichMedia'].filter((k) => raw.includes(k));
check(dangerous.length === 0, `no dangerous PDF actions leaked (${dangerous.join(', ') || 'none'})`);

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

// --- report ---
console.log(notes.join('\n'));
if (fails.length) {
  console.log('\n' + fails.join('\n'));
  console.log(`\nRESULT: FAIL (${fails.length})`);
  process.exit(1);
}
console.log('\nRESULT: PASS');
