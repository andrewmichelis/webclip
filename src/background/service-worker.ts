// WebClip MV3 service worker — capture orchestrator (M1: message router + active-tab resolution).
// MV3 workers are event-driven and may be suspended; keep no durable state in globals.

import { PRODUCT_NAME, VERSION, RESTRICTED_SCHEMES } from '../shared/constants.js';
import { isExtensionMessage } from '../shared/messages.js';
import type { PingResult, ActiveTabResult, StartCaptureResult } from '../shared/messages.js';
import type { ActiveTabInfo, CaptureCapability, UserSettings } from '../shared/types.js';
import { makeError } from '../shared/errors.js';
import { renderImageToPdfBytes } from '../renderer/pdf-renderer.js';
import { saveArtifacts } from './artifacts.js';
import { buildFilename, formatStamp } from '../shared/filename.js';
import { loadSettings, coerceSettings } from '../shared/settings.js';
import { captureFullPage } from './capture-fullpage.js';
import { injectController, startPick, stopPick, clearPick, hasPick, notifyInPage } from './page-inject.js';

// Set by CANCEL_CAPTURE; polled by the full-page loop to abort mid-capture (restore runs in finally).
let captureCancelled = false;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname || '';
  } catch {
    return '';
  }
}

function capabilityFor(url: string): CaptureCapability {
  const scheme = (url.split(':', 1)[0] + ':').toLowerCase();
  if (RESTRICTED_SCHEMES.includes(scheme)) {
    return { visible: true, fullPage: false, reason: 'This is a restricted browser page; only visible-area capture may work.' };
  }
  if (scheme === 'http:' || scheme === 'https:' || scheme === 'file:') {
    return { visible: true, fullPage: true };
  }
  return { visible: false, fullPage: false, reason: 'This page cannot be captured.' };
}

async function resolveActiveTab(): Promise<ActiveTabResult> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return { ok: false, error: makeError('NO_ACTIVE_TAB', 'No active tab to capture.') };
  }
  const url = tab.url ?? '';
  const info: ActiveTabInfo = {
    tabId: tab.id,
    windowId: tab.windowId,
    url,
    title: tab.title ?? '',
    domain: domainOf(url),
    capability: capabilityFor(url),
  };
  return { ok: true, tab: info };
}

async function captureVisible(tab: ActiveTabInfo, settings: UserSettings): Promise<StartCaptureResult> {
  try {
    const format = settings.imageFormat;
    const shotOpts: chrome.tabs.CaptureVisibleTabOptions =
      format === 'jpeg' ? { format: 'jpeg', quality: Math.round(settings.jpegQuality * 100) } : { format: 'png' };
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, shotOpts);
    const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
    const pdf = await renderImageToPdfBytes(
      { bytes, format },
      { paperSize: settings.paperSize, orientation: settings.orientation, title: tab.title, url: tab.url },
    );
    const now = new Date();
    const stamp = formatStamp(now);
    const filename = buildFilename(settings.filenameTemplate, {
      domain: tab.domain || tab.url,
      title: tab.title,
      date: stamp.date,
      time: stamp.time,
    });
    await saveArtifacts(pdf, filename, { url: tab.url, title: tab.title, domain: tab.domain }, 'visible', settings, {
      capturedAtUtc: now.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      captureId: crypto.randomUUID(),
    });
    return { ok: true, filename };
  } catch (e) {
    return {
      ok: false,
      error: makeError('SCREENSHOT_FAILED', 'Capture failed. Please try again.', {
        recoverable: true,
        technicalMessage: e instanceof Error ? e.message : String(e),
      }),
    };
  }
}

async function dispatchCapture(settings: UserSettings): Promise<StartCaptureResult> {
  captureCancelled = false; // fresh capture
  const tabRes = await resolveActiveTab();
  if (!tabRes.ok) return { ok: false, error: tabRes.error };
  const tab = tabRes.tab;

  if (settings.captureMode === 'full-page') {
    if (!tab.capability.fullPage) {
      return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'Full-page capture is not available on this page.') };
    }
    return captureFullPage(tab, settings, () => captureCancelled);
  }
  if (!tab.capability.visible) {
    return { ok: false, error: makeError('UNSUPPORTED_PAGE', tab.capability.reason ?? 'This page cannot be captured.') };
  }
  return captureVisible(tab, settings);
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!isExtensionMessage(message)) {
    sendResponse({ ok: false, error: makeError('UNKNOWN', 'Unrecognized message.') });
    return false;
  }

  switch (message.type) {
    case 'PING': {
      const res: PingResult = { ok: true, product: PRODUCT_NAME, version: VERSION };
      sendResponse(res);
      return false;
    }
    case 'GET_ACTIVE_TAB': {
      resolveActiveTab().then(sendResponse);
      return true; // async
    }
    case 'START_CAPTURE': {
      dispatchCapture(coerceSettings(message.settings)).then(sendResponse); // validate/clamp every field
      return true; // async
    }
    case 'CANCEL_CAPTURE': {
      captureCancelled = true;
      sendResponse({ ok: true });
      return false;
    }
    case 'START_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) {
          await injectController(tabRes.tab.tabId);
          await startPick(tabRes.tab.tabId);
        }
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'PANE_PICKED': {
      // Selection only — do NOT capture. The user chooses when to capture (via the popup) so a picked
      // section is optional and cancelable. Confirm with a toast since the popup is closed while picking.
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await notifyInPage(tabRes.tab.tabId, 'WebClip: section selected. Open WebClip and press Capture — or clear it.');
      })().catch(() => undefined);
      return false;
    }
    case 'STOP_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await stopPick(tabRes.tab.tabId);
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'PICK_CANCELLED': {
      return false;
    }
    case 'CLEAR_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        if (tabRes.ok) await clearPick(tabRes.tab.tabId);
      })().catch(() => undefined);
      sendResponse({ ok: true });
      return false;
    }
    case 'HAS_PICK': {
      void (async () => {
        const tabRes = await resolveActiveTab();
        sendResponse({ ok: true, picked: tabRes.ok ? await hasPick(tabRes.tab.tabId) : false });
      })().catch(() => sendResponse({ ok: true, picked: false }));
      return true; // async response
    }
    default: {
      // Exhaustiveness: message is `never` here.
      sendResponse({ ok: false, error: makeError('UNKNOWN', 'Unhandled message type.') });
      return false;
    }
  }
});

// Keyboard command: capture with the saved preferences (full-page or visible).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-full-page') {
    void loadSettings().then((s) => dispatchCapture(s));
  }
});

console.info(`[${PRODUCT_NAME}] service worker ready (v${VERSION}).`);
