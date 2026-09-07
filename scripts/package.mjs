#!/usr/bin/env node
// Package the built extension (dist/) into a Chrome Web Store-ready zip: <name>-<version>.zip.
// Pure Node (zlib deflate + crc32) — no external `zip` binary and no dependency, so it runs anywhere.
// Deterministic (fixed entry timestamps) so the same dist/ yields byte-identical zips. Run:
//   npm run package        # builds dist/ then zips it
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, crc32 } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const outName = `${pkg.name}-${pkg.version}.zip`;

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

let files;
try {
  // Ship only what the extension needs to run — exclude source maps (dev-only debug aids, dead weight
  // in a store package). The maps stay in dist/ for local debugging; they just do not go in the zip.
  files = (await walk(dist)).filter((f) => !f.endsWith('.map')).sort();
} catch {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}
if (files.length === 0) {
  console.error('dist/ is empty — run `npm run build` first.');
  process.exit(1);
}

const DOS_TIME = 0;                                   // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01 — fixed for reproducible zips
const local = [];
const central = [];
let offset = 0;

for (const abs of files) {
  const name = relative(dist, abs).split(/[\\/]/).join('/'); // zip paths use forward slashes
  const data = await readFile(abs);
  const crc = crc32(data) >>> 0;
  const comp = deflateRawSync(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
  lfh.writeUInt16LE(20, 4);         // version needed to extract (2.0)
  lfh.writeUInt16LE(0, 6);          // general purpose flags
  lfh.writeUInt16LE(8, 8);          // compression method: deflate
  lfh.writeUInt16LE(DOS_TIME, 10);
  lfh.writeUInt16LE(DOS_DATE, 12);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(comp.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);         // extra field length
  local.push(lfh, nameBuf, comp);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
  cdh.writeUInt16LE(20, 4);         // version made by
  cdh.writeUInt16LE(20, 6);         // version needed
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt16LE(DOS_TIME, 12);
  cdh.writeUInt16LE(DOS_DATE, 14);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(comp.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt16LE(0, 30);         // extra length
  cdh.writeUInt16LE(0, 32);         // comment length
  cdh.writeUInt16LE(0, 34);         // disk number start
  cdh.writeUInt16LE(0, 36);         // internal attributes
  cdh.writeUInt32LE(0, 38);         // external attributes
  cdh.writeUInt32LE(offset, 42);    // relative offset of local header
  central.push(cdh, nameBuf);

  offset += lfh.length + nameBuf.length + comp.length;
}

const cd = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);  // end of central directory signature
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);     // offset of central directory
eocd.writeUInt16LE(0, 20);          // comment length

const zip = Buffer.concat([...local, cd, eocd]);
await writeFile(resolve(root, outName), zip);
console.log(`packaged ${files.length} files -> ${outName}  (${(zip.length / 1024).toFixed(1)} KB)`);
console.log('Upload this zip at the Chrome Web Store Developer Dashboard: https://chrome.google.com/webstore/devconsole');
