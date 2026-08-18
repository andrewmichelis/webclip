// Options controller (M1): load persisted preferences, save on change.
// Also hosts the "make a saved capture printable" re-split tool (PDF -> paginated PDF).
import { loadSettings, saveSettings } from '../shared/settings.js';
import type { PaperSize, ImageFormat } from '../shared/types.js';
import { resplitPdfToPrintable } from '../renderer/resplit.js';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`WebClip options: missing #${id}`);
  return node as T;
}

/** Trigger a browser download of `bytes` as `name` via a temporary object URL (no permission needed). */
function downloadBytes(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Two-section tabs: Settings | Split a PDF. Opens on the section named by the URL hash (#split). */
function initTabs(): void {
  const tabs: Array<{ tab: string; panel: string }> = [
    { tab: 'tab-settings', panel: 'panel-settings' },
    { tab: 'tab-split', panel: 'panel-split' },
  ];
  const activate = (panelId: string): void => {
    for (const { tab, panel } of tabs) {
      const on = panel === panelId;
      el<HTMLButtonElement>(tab).classList.toggle('is-active', on);
      el<HTMLButtonElement>(tab).setAttribute('aria-selected', String(on));
      el<HTMLElement>(panel).classList.toggle('is-hidden', !on);
    }
  };
  for (const { tab, panel } of tabs) {
    el<HTMLButtonElement>(tab).addEventListener('click', () => activate(panel));
  }
  if (location.hash === '#split') activate('panel-split');
}

/** Wire the re-split tool: choose a saved PDF + page size -> download a paginated copy. */
function initResplit(): void {
  const file = el<HTMLInputElement>('opt-resplit-file');
  const paper = el<HTMLSelectElement>('opt-resplit-paper');
  const go = el<HTMLButtonElement>('opt-resplit-go');
  const status = el<HTMLParagraphElement>('opt-resplit-status');

  file.addEventListener('change', () => {
    go.disabled = !file.files || file.files.length === 0;
    status.textContent = '';
  });

  go.addEventListener('click', () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    void (async () => {
      go.disabled = true;
      status.textContent = 'Splitting…';
      try {
        const srcBytes = new Uint8Array(await chosen.arrayBuffer());
        const size = paper.value === 'LETTER' ? 'LETTER' : 'A4';
        const result = await resplitPdfToPrintable(srcBytes, size);
        const base = chosen.name.replace(/\.pdf$/i, '');
        downloadBytes(result.bytes, `${base}-${size.toLowerCase()}.pdf`);
        status.textContent = `Done — ${result.pageCount} ${size} page${result.pageCount === 1 ? '' : 's'}${result.smart ? ' (split at clean gaps)' : ''}.`;
      } catch (err) {
        status.textContent = `Could not split this PDF: ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        go.disabled = !file.files || file.files.length === 0;
      }
    })();
  });
}

async function init(): Promise<void> {
  const paper = el<HTMLSelectElement>('opt-paper');
  const format = el<HTMLSelectElement>('opt-format');
  const declutter = el<HTMLInputElement>('opt-declutter');
  const evidence = el<HTMLInputElement>('opt-evidence');
  const checksum = el<HTMLInputElement>('opt-checksum');
  const stamp = el<HTMLInputElement>('opt-stamp');
  const links = el<HTMLInputElement>('opt-links');
  const debugTiles = el<HTMLInputElement>('opt-debug-tiles');
  const saved = el<HTMLParagraphElement>('opt-saved');

  const s = await loadSettings();
  paper.value = s.paperSize;
  format.value = s.imageFormat;
  declutter.checked = s.declutter;
  evidence.checked = s.evidenceMode;
  checksum.checked = s.saveChecksum;
  stamp.checked = s.stamp;
  links.checked = s.links;
  debugTiles.checked = s.debugTiles;

  let timer: ReturnType<typeof setTimeout> | undefined;
  function flash(): void {
    saved.textContent = 'Saved';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { saved.textContent = ''; }, 1500);
  }

  paper.addEventListener('change', () => { void saveSettings({ paperSize: paper.value as PaperSize }).then(flash); });
  format.addEventListener('change', () => { void saveSettings({ imageFormat: format.value as ImageFormat }).then(flash); });
  declutter.addEventListener('change', () => { void saveSettings({ declutter: declutter.checked }).then(flash); });
  evidence.addEventListener('change', () => { void saveSettings({ evidenceMode: evidence.checked }).then(flash); });
  checksum.addEventListener('change', () => { void saveSettings({ saveChecksum: checksum.checked }).then(flash); });
  stamp.addEventListener('change', () => { void saveSettings({ stamp: stamp.checked }).then(flash); });
  links.addEventListener('change', () => { void saveSettings({ links: links.checked }).then(flash); });
  debugTiles.addEventListener('change', () => { void saveSettings({ debugTiles: debugTiles.checked }).then(flash); });

  initTabs();
  initResplit();
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
