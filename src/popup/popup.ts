// Popup controller (M1): resolve the active tab via the service worker, reflect its capture
// capability, and wire the capture action to the (not-yet-implemented) engine contract.
// Untrusted page-derived strings are rendered with textContent only (XSS-safe).

import { DEFAULT_SETTINGS } from '../shared/types.js';
import { loadSettings } from '../shared/settings.js';
import type { CaptureMode, UserSettings, CaptureProgress, PaperSize, Orientation } from '../shared/types.js';
import type { ExtensionMessage, ActiveTabResult, StartCaptureResult } from '../shared/messages.js';

function send<T>(message: ExtensionMessage): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`WebClip popup: missing #${id}`);
  return node as T;
}

const statusEl = el<HTMLParagraphElement>('wc-status');
function setStatus(text: string, kind: 'default' | 'error' | 'ok' = 'default'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('is-error', kind === 'error');
  statusEl.classList.toggle('is-ok', kind === 'ok');
}

function selectedMode(): CaptureMode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'visible' ? 'visible' : 'full-page';
}

function progressText(p: CaptureProgress): string {
  switch (p.phase) {
    case 'preparing': return 'Preparing page…';
    case 'capturing': return `Capturing… ${p.completed}/${p.total} (${p.percent}%)`;
    case 'rendering': return 'Building PDF…';
    case 'downloading': return 'Saving…';
    case 'restoring': return 'Finishing…';
  }
}

// Live progress from the service worker during a long full-page capture.
chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'JOB_PROGRESS') {
    setStatus(progressText((msg as { payload: CaptureProgress }).payload));
  }
});

async function resolveTab(): Promise<void> {
  const sourceEl = el<HTMLParagraphElement>('wc-source');
  const captureBtn = el<HTMLButtonElement>('wc-capture');
  const fullRadio = document.querySelector<HTMLInputElement>('input[name="mode"][value="full-page"]');
  const visibleRadio = document.querySelector<HTMLInputElement>('input[name="mode"][value="visible"]');

  const res = await send<ActiveTabResult>({ type: 'GET_ACTIVE_TAB' });
  if (!res.ok) {
    sourceEl.textContent = res.error.message;
    captureBtn.disabled = true;
    setStatus(res.error.message, 'error');
    return;
  }

  const { tab } = res;
  sourceEl.textContent = tab.domain || tab.url || 'this page';
  sourceEl.title = tab.url;

  if (!tab.capability.fullPage && fullRadio && visibleRadio) {
    fullRadio.checked = false;
    fullRadio.disabled = true;
    fullRadio.closest('.wc-radio')?.classList.add('is-disabled');
    visibleRadio.checked = true;
    if (tab.capability.reason) setStatus(tab.capability.reason);
  }

  if (!tab.capability.visible && !tab.capability.fullPage) {
    captureBtn.disabled = true;
    setStatus(tab.capability.reason ?? 'This page cannot be captured.', 'error');
  }
}

// Saved preferences (evidence/checksum/stamp/declutter/etc.) live behind the gear (options page);
// the popup carries only the per-capture choices (mode, paper, layout) and layers them over the saved base.
let loaded: UserSettings = DEFAULT_SETTINGS;
function readSettings(): UserSettings {
  return {
    ...loaded,
    captureMode: selectedMode(),
    paperSize: el<HTMLSelectElement>('wc-paper').value as PaperSize,
    orientation: el<HTMLSelectElement>('wc-layout').value as Orientation,
  };
}

let picking = false; // pick mode armed (popup open, waiting for a page click)
let sectionSelected = false; // a pane is currently selected on the page
function updatePickUI(): void {
  const btn = el<HTMLButtonElement>('wc-pick');
  btn.textContent = picking
    ? 'Cancel selection'
    : sectionSelected
      ? 'Clear selected section'
      : 'Pick a section to capture…';
}
async function refreshPickState(): Promise<void> {
  const res = await send<{ ok: boolean; picked?: boolean }>({ type: 'HAS_PICK' });
  sectionSelected = res?.picked === true;
  updatePickUI();
  if (sectionSelected && !picking) setStatus('A section is selected — Capture will save just that section.');
}
function setPicking(on: boolean): void {
  picking = on;
  updatePickUI();
}
async function startPicking(): Promise<void> {
  await send<{ ok: boolean }>({ type: 'START_PICK' });
  setPicking(true);
  // The picker just SELECTS a section; capturing stays a separate, deliberate step.
  setStatus('Click a section on the page to select it. Then press Capture (or Esc to cancel).');
}
async function stopPicking(): Promise<void> {
  await send<{ ok: boolean }>({ type: 'STOP_PICK' });
  setPicking(false);
  setStatus('Ready');
}
async function clearSelection(): Promise<void> {
  await send<{ ok: boolean }>({ type: 'CLEAR_PICK' });
  sectionSelected = false;
  updatePickUI();
  setStatus('Selection cleared. Capture will save the whole page.');
}
async function onPick(): Promise<void> {
  if (picking) await stopPicking();
  else if (sectionSelected) await clearSelection();
  else await startPicking();
}

let captureActive = false;
async function onCapture(): Promise<void> {
  if (picking) await stopPicking(); // stop arming the picker; a section already selected is still used
  const captureBtn = el<HTMLButtonElement>('wc-capture');
  captureActive = true;
  captureBtn.textContent = 'Cancel';
  setStatus('Starting…');
  const settings = readSettings();
  if (sectionSelected) settings.captureMode = 'full-page'; // a selected section is captured full-page
  const res = await send<StartCaptureResult>({ type: 'START_CAPTURE', settings });
  captureActive = false;
  captureBtn.textContent = 'Capture & Save PDF';
  sectionSelected = false; // the capture restored the page, clearing any selection
  updatePickUI();
  if (res.ok) {
    const pagesText = res.pages ? ` (${res.pages} page${res.pages === 1 ? '' : 's'})` : '';
    let msg = `Saved ${res.filename}${pagesText}`;
    if (res.warning) msg += ` — ${res.warning}`;
    setStatus(msg, 'ok');
  } else {
    const detail = res.error.technicalMessage ? ` [${res.error.technicalMessage}]` : '';
    setStatus(res.error.message + detail, res.error.recoverable ? 'default' : 'error');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) void stopPicking(); // cancel pick from the popup too
});

document.addEventListener('DOMContentLoaded', () => {
  el<HTMLButtonElement>('wc-capture').addEventListener('click', () => {
    if (captureActive) {
      void send<{ ok: boolean }>({ type: 'CANCEL_CAPTURE', jobId: '' });
      setStatus('Cancelling…');
    } else {
      void onCapture();
    }
  });
  el<HTMLButtonElement>('wc-pick').addEventListener('click', () => { void onPick(); });
  el<HTMLButtonElement>('wc-gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
  const openTab = (url: string): void => void chrome.tabs.create({ url });
  const GITHUB_URL = 'https://github.com/andrewmichelis/webclip';
  el<HTMLButtonElement>('wc-help').addEventListener('click', () => openTab(`${GITHUB_URL}#readme`)); // full help + source
  el<HTMLButtonElement>('wc-github').addEventListener('click', () => openTab(GITHUB_URL));
  el<HTMLButtonElement>('wc-brand').addEventListener('click', () => openTab('https://knackmentor.com/webclip/'));
  el<HTMLButtonElement>('wc-resplit').addEventListener('click', () => {
    // The re-split tool lives on the options page (it needs a file picker); open it on its own tab.
    void chrome.tabs.create({ url: chrome.runtime.getURL('options.html#split') });
  });
  // Reflect saved preferences in the per-capture selects, then resolve the tab.
  void loadSettings().then((s) => {
    loaded = s;
    el<HTMLSelectElement>('wc-paper').value = s.paperSize;
    el<HTMLSelectElement>('wc-layout').value = s.orientation;
  });
  void resolveTab();
  void refreshPickState(); // reflect a section selected on a previous open
});
