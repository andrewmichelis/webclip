// Deterministic, safe filename generation. Pure functions (unit-tested).

export interface FilenameParts {
  domain: string;
  title: string;
  date: string; // YYYY-MM-DD
  time: string; // HHMMSS
}

/** Local date/time stamp for filenames. */
export function formatStamp(d: Date): { date: string; time: string } {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

/** Sanitize one path segment: strip accents, keep [A-Za-z0-9._-], collapse + trim, cap length. */
function slug(input: string, maxLen: number): string {
  let s = (input ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''); // drop diacritics
  s = s.replace(/[^A-Za-z0-9._ -]+/g, ' ').trim();
  s = s.replace(/\s+/g, '-');
  s = s.replace(/([-_.])[-_.]+/g, '$1'); // collapse runs of separators
  s = s.replace(/^[-_.]+|[-_.]+$/g, ''); // trim edge separators
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[-_.]+$/, '');
  return s;
}

/** Build a sanitized `<...>.pdf` filename from a template. Never allows directory traversal. */
export function buildFilename(template: string, parts: FilenameParts): string {
  const domain = slug(parts.domain.replace(/^www\./, ''), 40) || 'page';
  const title = slug(parts.title, 60) || 'capture';
  let name = template
    .replace(/\{domain\}/g, domain)
    .replace(/\{title\}/g, title)
    .replace(/\{date\}/g, parts.date)
    .replace(/\{time\}/g, parts.time);
  name = name.replace(/[/\\]+/g, '-').replace(/\.{2,}/g, '.'); // no traversal
  name = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_{2,}/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  if (!name) name = 'webclip-capture';
  return `${name}.pdf`;
}
