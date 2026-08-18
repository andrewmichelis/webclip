import { describe, it, expect } from 'vitest';
import { buildFilename, formatStamp } from '../../src/shared/filename.js';

const parts = { domain: 'www.example.com', title: 'My Great Article: Part 2!', date: '2026-08-17', time: '121830' };

describe('buildFilename', () => {
  it('produces a sanitized .pdf name from the default template', () => {
    const n = buildFilename('{domain}_{title}_{date}_{time}', parts);
    expect(n).toMatch(/\.pdf$/);
    expect(n).toMatch(/^[A-Za-z0-9._-]+$/); // only safe filename chars
    expect(n).toContain('example.com'); // www stripped, dot preserved
    expect(n).toContain('2026-08-17');
  });

  it('strips directory traversal and path separators', () => {
    const n = buildFilename('{title}', { ...parts, title: '../../etc/passwd' });
    expect(n).not.toContain('..');
    expect(n).not.toContain('/');
    expect(n).toMatch(/\.pdf$/);
  });

  it('falls back to a default when all parts are empty', () => {
    const n = buildFilename('{domain}_{title}', { domain: '', title: '', date: '', time: '' });
    expect(n.endsWith('.pdf')).toBe(true);
    expect(n.length).toBeGreaterThan(4);
  });

  it('caps overly long titles', () => {
    const n = buildFilename('{title}', { ...parts, title: 'a'.repeat(200) });
    expect(n.length).toBeLessThan(80);
  });
});

describe('formatStamp', () => {
  it('formats a local date and time', () => {
    const s = formatStamp(new Date(2026, 7, 17, 9, 8, 3)); // month index 7 = August
    expect(s.date).toBe('2026-08-17');
    expect(s.time).toBe('090803');
  });
});
