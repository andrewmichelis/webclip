// Service-worker drivers for the injected page controller (WC-M3).
// The full-page orchestrator (WC-M4) composes these: inject once, then prepare ->
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

export async function setFixedHidden(tabId: number, hidden: boolean, barLikeOnly = false): Promise<number> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (h: boolean, b: boolean) => globalThis.__webclipController?.setFixedHidden(h, b),
    args: [hidden, barLikeOnly],
  });
  return (res?.result as number | undefined) ?? 0;
}

export async function startPick(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__webclipController?.startPick(),
  });
}

/** Enter "mark a section" mode (WC-M11). Resolves once the highlighter is installed. */
export async function startMark(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__webclipController?.startMark(),
  });
}

/** Cancel armed mark mode (the toolbar's Mark button, toggled to Cancel). Best-effort. */
export async function cancelMark(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__webclipController?.cancelMark() });
  } catch {
    // tab navigated/closed
  }
}

/** Flip the toolbar's Mark button between idle (arm) and armed (cancel) so the label tracks mark mode. */
export async function setMarkArmed(tabId: number, armed: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (barId: string, on: boolean) => {
        const btn = document.getElementById(barId)?.querySelector('[data-wc-markbtn]') as HTMLElement | null;
        if (!btn) return;
        btn.setAttribute('data-wc-markbtn', on ? 'armed' : 'idle');
        btn.textContent = on ? '✕ Cancel mark' : '🎯 Mark (m)';
        btn.style.setProperty('background', on ? '#b91c1c' : '#16a34a', 'important'); // beat page !important
        btn.style.setProperty('color', '#fff', 'important');
      },
      args: [SNAP_BAR_ID, armed],
    });
  } catch {
    // tab navigated/closed
  }
}

/** Plan the marked region's capture (its size + tile count). Null if nothing is marked. */
export async function regionInfo(tabId: number, extraOverlapCss = 0): Promise<import('../shared/types.js').RegionInfo | null> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [extraOverlapCss],
    func: (extra: number) => globalThis.__webclipController?.regionInfo(extra) ?? null,
  });
  return (res?.result as import('../shared/types.js').RegionInfo | null) ?? null;
}

/** WC-M13 P2a: make the marked block's own scroller the active scroller (self-scroll marks only), so the
 *  shared warmup/engine drives it. Returns true if it did. Undo with {@link clearForcedScroller}. */
export async function useMarkedBlockAsScroller(tabId: number): Promise<boolean> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.useMarkedBlockAsScroller() === true,
    });
    return res?.result === true;
  } catch {
    return false;
  }
}

/** Undo useMarkedBlockAsScroller() so normal scroller resolution resumes for the region tiling. */
export async function clearForcedScroller(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.__webclipController?.clearForcedScroller() });
  } catch {
    /* ignore */
  }
}

/** Scroll the marked region's slice `i` into view and return its crop box + destination offset. */
export async function regionPositionTile(tabId: number, i: number): Promise<import('../shared/types.js').RegionTilePos | null> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (idx: number) => globalThis.__webclipController?.regionPositionTile(idx) ?? null,
    args: [i],
  });
  return (res?.result as import('../shared/types.js').RegionTilePos | null) ?? null;
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

/** Height (CSS px) of the viewport-top-pinned frozen chrome at the CURRENT scroll — for the scroll-offset so
 *  content behind a fixed/sticky header isn't lost between tiles. Call while scrolled (header pinned). 0 on error. */
export async function measureTopFrozen(tabId: number): Promise<number> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => (await globalThis.__webclipController?.measureTopFrozenCss()) ?? 0,
    });
    return (res?.result as number) ?? 0;
  } catch {
    return 0;
  }
}

/** G2: links inside the marked block, in the block's own content coordinates (see collectRegionLinks). */
export async function collectRegionLinks(tabId: number): Promise<import('../shared/types.js').PageLink[]> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.collectRegionLinks() ?? [],
    });
    return (res?.result as import('../shared/types.js').PageLink[]) ?? [];
  } catch {
    return [];
  }
}

/** WC-M12: section-header anchors (key + content-Y) for splicing marked/snapped pieces into the base. */
export async function collectAnchors(tabId: number): Promise<import('../shared/types.js').Anchor[]> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.collectAnchors() ?? [],
    });
    return (res?.result as import('../shared/types.js').Anchor[]) ?? [];
  } catch {
    return [];
  }
}

/** WC-M12: default tab-panel extents (content-Y) so the worker can splice other-tab marks exactly after
 *  the default view (and patch a re-marked default in place). */
export async function collectTabPanels(tabId: number): Promise<import('../shared/types.js').TabPanelExtent[]> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.collectTabPanels() ?? [],
    });
    return (res?.result as import('../shared/types.js').TabPanelExtent[]) ?? [];
  } catch {
    return [];
  }
}

/** WC-M12: an open modal's fixed header/footer bands (top-viewport CSS px), so the capture can stack them
 *  around the tiled body. Null when there is no modal / no separate inner pane. */
export async function modalBands(tabId: number): Promise<import('../shared/types.js').ModalBands | null> {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__webclipController?.modalBands() ?? null,
    });
    return (res?.result as import('../shared/types.js').ModalBands | null) ?? null;
  } catch {
    return null;
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
 *  (e.g. after a picked capture). Avoids the `notifications` permission (ARCH-WC-04). */
export async function notifyInPage(tabId: number, message: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg: string) => {
        const el = document.createElement('div');
        el.textContent = msg;
        el.setAttribute('data-webclip-ui', ''); // WebClip's own transient UI — never include it in a capture
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

const SNAP_BAR_ID = 'webclip-snapshot-bar';

/** Inject (or refresh the count of) the floating snapshot toolbar (WC-M10). Tagged data-webclip-ui so
 *  it is hidden during each shot and never appears in a capture. Its buttons message the SW. */
export async function showSnapshotBar(tabId: number, count: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (id: string, n: number) => {
      const label = (n2: number): string => `${n2} captured`;
      const existing = document.getElementById(id);
      if (existing) {
        const c = existing.querySelector('[data-wc-count]');
        if (c) c.textContent = label(n);
        (existing as HTMLElement).style.removeProperty('display');
        return;
      }
      const bar = document.createElement('div');
      bar.id = id;
      bar.setAttribute('data-webclip-ui', '');
      // IMPORTANT priority on every visual property: course players (SCORM/Rise) style buttons/divs with
      // `!important`, which would otherwise override our inline styles and strip the colours.
      const imp = (el: HTMLElement, props: Record<string, string>): void => {
        for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, 'important');
      };
      imp(bar, {
        position: 'fixed', 'z-index': '2147483647', left: '50%', bottom: '20px', transform: 'translateX(-50%)',
        display: 'flex', gap: '10px', 'align-items': 'center', padding: '10px 14px', background: 'rgba(20,22,26,0.96)',
        color: '#fff', 'border-radius': '10px', font: '13px system-ui, -apple-system, sans-serif',
        'box-shadow': '0 6px 24px rgba(0,0,0,0.35)', margin: '0', 'line-height': 'normal',
      });
      const style = (b: HTMLButtonElement, bg: string): void => {
        imp(b, { font: 'inherit', cursor: 'pointer', border: '0', 'border-radius': '6px', padding: '6px 12px',
          background: bg, color: '#fff', 'box-shadow': 'none', 'text-transform': 'none', margin: '0', 'min-width': '0', opacity: '1' });
      };
      const mk = (label: string, bg: string, type: string, tearMark = false): HTMLButtonElement => {
        const b = document.createElement('button');
        b.textContent = label;
        style(b, bg);
        b.addEventListener('click', () => {
          // Done/Cancel end the session: tear any in-progress mark overlay + its listeners down IN-PAGE first
          // (synchronous, no service-worker round-trip → can never stall the button), so no green selection is
          // stranded and the page's own clicks aren't intercepted afterwards. The SW also fires this
          // non-blocking as a backstop.
          if (tearMark) { try { globalThis.__webclipController?.cancelMark?.(); } catch { /* controller absent */ } }
          void chrome.runtime.sendMessage({ type }).catch(() => undefined);
        });
        return b;
      };
      // The Mark button is a TOGGLE: idle = arm mark mode; armed = cancel it (so you can start the next
      // one). The SW flips its label/colour (setMarkArmed) as mark mode arms / captures / cancels.
      const markBtn = document.createElement('button');
      markBtn.textContent = '🎯 Mark (m)';
      markBtn.setAttribute('data-wc-markbtn', 'idle');
      style(markBtn, '#16a34a');
      markBtn.addEventListener('click', () => {
        const armed = markBtn.getAttribute('data-wc-markbtn') === 'armed';
        void chrome.runtime.sendMessage({ type: armed ? 'SNAPSHOT_MARK_CANCEL' : 'SNAPSHOT_MARK' }).catch(() => undefined);
      });
      const count = document.createElement('span');
      count.setAttribute('data-wc-count', '');
      // Breathing room + a min-width so a 1- vs 2-digit count doesn't crowd Mark against Undo.
      imp(count, { opacity: '0.85', color: '#fff', padding: '0 4px', 'white-space': 'nowrap',
        'min-width': '68px', 'text-align': 'center', font: 'inherit' });
      count.textContent = label(n);
      bar.append(
        markBtn,
        count,
        mk('↶ Undo', '#8a5a00', 'SNAPSHOT_UNDO'),
        mk('✓ Done', '#1a7f37', 'SNAPSHOT_FINISH', true),
        mk('✕', '#555', 'SNAPSHOT_CANCEL', true),
      );
      document.documentElement.appendChild(bar);
    },
    args: [SNAP_BAR_ID, count],
  });
}

/** Hide/show the snapshot toolbar around a captureVisibleTab so it is never in the shot. */
export async function setSnapshotBarHidden(tabId: number, hidden: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (id: string, h: boolean) => {
        const bar = document.getElementById(id);
        if (bar) (bar as HTMLElement).style.display = h ? 'none' : 'flex';
      },
      args: [SNAP_BAR_ID, hidden],
    });
  } catch {
    // tab navigated/closed
  }
}

export async function removeSnapshotBar(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (id: string) => {
        document.getElementById(id)?.remove();
        // Also clear any leftover mark overlay in the SAME fast top-frame script, so a Done/Cancel from an
        // armed state never strands a green selection — WITHOUT a second executeScript on the critical exit
        // path (which stalled Done on heavy pages). A framed overlay self-heals on the next arm (startMark).
        for (const el of Array.from(document.querySelectorAll('[data-webclip-mark],[data-webclip-mark-label]'))) el.remove();
      },
      args: [SNAP_BAR_ID],
    });
  } catch {
    // tab navigated/closed
  }
}

// Session keyboard shortcuts (WC-M11): m = Mark, Ctrl/Cmd+Z = Undo — so the user never has to return to
// the toolbar mid-flow. Installed once at snapshot start, removed on Done/Cancel. Ignores keys typed into
// inputs, and defers m while a mark selection is active (arrows/Enter/Esc belong to marking).
export async function installSessionKeys(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const g = globalThis as unknown as { __webclipSessionKeys?: (e: KeyboardEvent) => void };
        if (g.__webclipSessionKeys) return;
        const onKey = (e: KeyboardEvent): void => {
          const t = e.target as HTMLElement | null;
          const tag = t?.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
          if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
            e.preventDefault();
            void chrome.runtime.sendMessage({ type: 'SNAPSHOT_UNDO' }).catch(() => undefined);
            return;
          }
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          const d = t?.ownerDocument || document; // key pressed in a frame → check THAT doc for mark mode
          if (d.querySelector('[data-webclip-mark]')) return; // in mark mode → let it own its keys
          if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            void chrome.runtime.sendMessage({ type: 'SNAPSHOT_MARK' }).catch(() => undefined);
          }
        };
        g.__webclipSessionKeys = onKey;
        // Install on the top document AND every same-origin frame — on course players (SCORM/Rise) the
        // keyboard focus is inside the iframe, so a top-only listener never sees m/s.
        const install = (doc: Document): void => {
          try {
            doc.addEventListener('keydown', onKey, true);
          } catch {
            /* cross-origin */
          }
          try {
            for (const f of Array.from(doc.querySelectorAll('iframe'))) {
              const cd = (f as HTMLIFrameElement).contentDocument;
              if (cd) install(cd);
            }
          } catch {
            /* cross-origin */
          }
        };
        install(document);
      },
    });
  } catch {
    // tab navigated/closed
  }
}

export async function removeSessionKeys(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const g = globalThis as unknown as { __webclipSessionKeys?: (e: KeyboardEvent) => void };
        const fn = g.__webclipSessionKeys;
        if (!fn) return;
        const remove = (doc: Document): void => {
          try {
            doc.removeEventListener('keydown', fn, true);
          } catch {
            /* ignore */
          }
          try {
            for (const f of Array.from(doc.querySelectorAll('iframe'))) {
              const cd = (f as HTMLIFrameElement).contentDocument;
              if (cd) remove(cd);
            }
          } catch {
            /* ignore */
          }
        };
        remove(document);
        g.__webclipSessionKeys = undefined;
      },
    });
  } catch {
    // tab navigated/closed
  }
}

// Block USER scrolling (wheel / touch / scroll keys) during a capture, so playing with the scroll can't
// disturb the tool's programmatic scrolling mid-capture. Tool scroll (scrollTop = / scrollTo) is unaffected.
// Installed in the top document + every same-origin frame (course players scroll inside the iframe).
export async function setScrollLock(tabId: number, on: boolean): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (lock: boolean) => {
        const g = globalThis as unknown as {
          __wcScrollLock?: { wheel: (e: Event) => void; key: (e: KeyboardEvent) => void };
        };
        const wheelEvs = ['wheel', 'mousewheel', 'DOMMouseScroll', 'touchmove'];
        const walk = (doc: Document, h: { wheel: (e: Event) => void; key: (e: KeyboardEvent) => void }, add: boolean): void => {
          try {
            for (const ev of wheelEvs) {
              if (add) doc.addEventListener(ev, h.wheel, { capture: true, passive: false });
              else doc.removeEventListener(ev, h.wheel, true);
            }
            // Keyboard scrolling (Space / PageUp/Down / Home/End / arrows) also disturbs the tiling.
            if (add) doc.addEventListener('keydown', h.key as EventListener, { capture: true, passive: false });
            else doc.removeEventListener('keydown', h.key as EventListener, true);
            for (const f of Array.from(doc.querySelectorAll('iframe'))) {
              const cd = (f as HTMLIFrameElement).contentDocument;
              if (cd) walk(cd, h, add);
            }
          } catch {
            /* cross-origin */
          }
        };
        if (lock) {
          if (g.__wcScrollLock) return;
          const wheel = (e: Event): void => {
            e.preventDefault();
            e.stopPropagation();
          };
          const SCROLL_KEYS = new Set([' ', 'Spacebar', 'PageUp', 'PageDown', 'End', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
          const key = (e: KeyboardEvent): void => {
            const t = e.target as HTMLElement | null;
            const tag = t?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return; // don't hijack typing
            if (SCROLL_KEYS.has(e.key)) {
              e.preventDefault();
              e.stopPropagation();
            }
          };
          g.__wcScrollLock = { wheel, key };
          walk(document, g.__wcScrollLock, true);
        } else if (g.__wcScrollLock) {
          walk(document, g.__wcScrollLock, false);
          g.__wcScrollLock = undefined;
        }
      },
      args: [on],
    });
  } catch {
    // tab navigated/closed
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

/** Idempotent restore. Best-effort: never throws (cleanup must run in a finally path, §37). */
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
