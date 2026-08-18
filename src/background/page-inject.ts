// Service-worker drivers for the injected page controller.
// The full-page orchestrator composes these: inject once, then prepare ->
// measure -> scrollTo (per tile) -> setFixedHidden -> restore.
import type { PageMetrics, PrepareOptions, ScrollContext } from '../shared/types.js';

const CONTROLLER_FILE = 'page-controller.js';

/** Inject the controller once into the tab's isolated world (idempotent to re-inject). */
export async function injectController(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTROLLER_FILE] });
}

export async function preparePage(tabId: number, opts: PrepareOptions): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (o: PrepareOptions) => globalThis.__webclipController?.prepare(o),
    args: [opts],
  });
}

export async function measurePage(tabId: number): Promise<PageMetrics> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__webclipController?.measure(),
  });
  const metrics = res?.result as PageMetrics | undefined;
  if (!metrics) throw new Error('page controller unavailable (measure)');
  return metrics;
}

export async function scrollContext(tabId: number): Promise<ScrollContext | undefined> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__webclipController?.scrollContext(),
  });
  return res?.result as ScrollContext | undefined;
}

export async function scrollPageTo(tabId: number, x: number, y: number): Promise<{ scrollX: number; scrollY: number }> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (px: number, py: number) => globalThis.__webclipController?.scrollTo(px, py),
    args: [x, y],
  });
  return (res?.result as { scrollX: number; scrollY: number } | undefined) ?? { scrollX: x, scrollY: y };
}

export async function setFixedHidden(tabId: number, hidden: boolean): Promise<number> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (h: boolean) => globalThis.__webclipController?.setFixedHidden(h),
    args: [hidden],
  });
  return (res?.result as number | undefined) ?? 0;
}

export async function startPick(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__webclipController?.startPick(),
  });
}

/** Clear the selected section (remove its outline + pick marker). */
export async function clearPick(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.clearPick(),
    });
  } catch {
    // Tab navigated/closed; nothing to clear.
  }
}

/** Collect meaningful page links (positions in the captured panel's content) for PDF link annotations. */
export async function collectLinks(tabId: number): Promise<import('../shared/types.js').PageLink[]> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.collectLinks() ?? [],
    });
    return (res?.result as import('../shared/types.js').PageLink[]) ?? [];
  } catch {
    return [];
  }
}

/** Whether a section is currently selected on the page. */
export async function hasPick(tabId: number): Promise<boolean> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.hasPick() === true,
    });
    return res?.result === true;
  } catch {
    return false;
  }
}

/** Brief in-page toast (bottom-right, auto-dismiss) — completion feedback when the popup is closed
 *  (e.g. after a picked capture). Avoids the `notifications` permission. */
export async function notifyInPage(tabId: number, message: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg: string) => {
        const el = document.createElement('div');
        el.textContent = msg;
        const s = el.style;
        s.position = 'fixed';
        s.zIndex = '2147483647';
        s.right = '16px';
        s.bottom = '16px';
        s.maxWidth = '360px';
        s.padding = '10px 14px';
        s.background = 'rgba(20,22,26,0.95)';
        s.color = '#fff';
        s.font = '13px system-ui, -apple-system, sans-serif';
        s.borderRadius = '8px';
        s.boxShadow = '0 4px 16px rgba(0,0,0,0.3)';
        s.pointerEvents = 'none';
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 4200);
      },
      args: [message],
    });
  } catch {
    // Tab navigated/closed; nothing to show.
  }
}

export async function stopPick(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipCancelPick?.(),
    });
  } catch {
    // Tab may have navigated/closed; nothing to cancel.
  }
}

/** Idempotent restore. Best-effort: never throws (cleanup must run in a finally path). */
export async function restorePage(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.restore(),
    });
  } catch {
    // Tab may have navigated/closed; nothing to restore.
  }
}
