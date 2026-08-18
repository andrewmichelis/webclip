// Injected page controller. Bundled as a classic (IIFE) content script and
// injected into the active tab's isolated world; subsequent executeScript({func}) calls
// invoke `globalThis.__webclipController`. Restore state lives in DOM attributes so it
// survives across separate injections/calls. Every DOM change is reversible.
import type { PageMetrics, PrepareOptions, ScrollContext, PageLink } from '../shared/types.js';

const STYLE_ID = 'webclip-capture-style';
const DECLUTTER_ATTR = 'data-webclip-declutter'; // persistent hide for the whole capture
const FIXED_ATTR = 'data-webclip-fixed'; // per-tile fixed/sticky suppression (toggled by M4)
const SCROLL_ATTR = 'data-webclip-scroll';
const SB_ATTR = 'data-webclip-scroll-behavior';
const PICKED_ATTR = 'data-webclip-picked'; // user-selected scroll pane (overrides auto-detection)

// Conservative, high-signal clutter selectors (cookie/consent/ad banners). Case-insensitive.
const CLUTTER_SELECTORS = [
  '[id*="cookie" i]', '[class*="cookie" i]', '[aria-label*="cookie" i]',
  '[id*="consent" i]', '[class*="consent" i]',
  '[id*="gdpr" i]', '[class*="gdpr" i]',
  '[id*="onetrust" i]', '#onetrust-banner-sdk', '#onetrust-consent-sdk',
  'ins.adsbygoogle', '[class*="advert" i]', '[id*="cookie-banner" i]',
];

interface Controller {
  prepare(opts: PrepareOptions): void;
  measure(): PageMetrics;
  scrollContext(): ScrollContext;
  scrollTo(x: number, y: number): { scrollX: number; scrollY: number };
  setFixedHidden(hidden: boolean): number;
  declutter(on: boolean): void;
  startPick(): void;
  clearPick(): void;
  hasPick(): boolean;
  collectLinks(): PageLink[];
  restore(): void;
}

const PICK_OUTLINE = 'data-webclip-pick-outline'; // marks the inline outline we add to the selected pane
/** Give the selected pane a persistent outline so the user can see what will be captured, and clear it. */
function markPicked(el: HTMLElement): void {
  clearPicked();
  el.setAttribute(PICKED_ATTR, '');
  el.setAttribute(PICK_OUTLINE, el.style.outline || '');
  el.style.outline = '3px solid #2f6df6';
  el.style.outlineOffset = '-3px';
}
/** Remove just the selection OUTLINE (so it never appears in a capture) — keeps the pick marker. */
function clearPickOutline(): void {
  document.querySelectorAll(`[${PICK_OUTLINE}]`).forEach((e) => {
    if (e instanceof HTMLElement) {
      const prev = e.getAttribute(PICK_OUTLINE) || '';
      e.style.outline = prev;
      if (!prev) e.style.removeProperty('outline');
      e.style.removeProperty('outline-offset');
      e.removeAttribute(PICK_OUTLINE);
    }
  });
}
function clearPicked(): void {
  clearPickOutline();
  document.querySelectorAll(`[${PICKED_ATTR}]`).forEach((e) => e.removeAttribute(PICKED_ATTR));
}

// Nearest scrollable ancestor of a hovered element (for the "Pick a section" picker).
function scrollableAncestor(el: Element | null): HTMLElement | null {
  let node = el instanceof HTMLElement ? el : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') && node.scrollHeight - node.clientHeight > 20) {
      return node;
    }
    node = node.parentElement;
  }
  return null; // null → the document/window scroll
}

// The active scroller: null = the document/window; otherwise the dominant inner scroll panel.
// Resolved once per injection (module scope survives within a single capture).
let scrollerEl: HTMLElement | null = null;
let scrollerResolved = false;
let originalScrollerTop = 0;

function resolveScroller(): HTMLElement | null {
  if (scrollerResolved) return scrollerEl;
  scrollerResolved = true;
  // A user-picked pane (via "Pick a section") overrides auto-detection.
  const picked = document.querySelector(`[${PICKED_ATTR}]`);
  if (picked instanceof HTMLElement) {
    scrollerEl = picked;
    return picked;
  }
  if (docHeight() - window.innerHeight > 4) {
    scrollerEl = null; // the document itself scrolls
    return null;
  }
  // Among elements that actually scroll, prefer the MAIN content pane — the one with the largest
  // visible AREA — not a narrow side list/menu that may have a longer scroll range. (Pierces shadow.)
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of deepElements(document.body)) {
    const range = el.scrollHeight - el.clientHeight;
    if (range <= 40) continue;
    if (el.clientHeight < window.innerHeight * 0.4) continue;
    if (el.clientWidth < window.innerWidth * 0.3) continue; // skip narrow menus / side lists
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const score = el.clientWidth * el.clientHeight; // largest visible scroll area ≈ main content
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  scrollerEl = best;
  return best;
}

function docWidth(): number {
  const d = document.documentElement;
  const b = document.body;
  const se = document.scrollingElement;
  return Math.max(d.scrollWidth, d.offsetWidth, d.clientWidth, b ? b.scrollWidth : 0, b ? b.offsetWidth : 0, se ? se.scrollWidth : 0);
}
function docHeight(): number {
  const d = document.documentElement;
  const b = document.body;
  const se = document.scrollingElement;
  return Math.max(d.scrollHeight, d.offsetHeight, d.clientHeight, b ? b.scrollHeight : 0, b ? b.offsetHeight : 0, se ? se.scrollHeight : 0);
}

// Depth-first walk that PIERCES open shadow roots — modern apps (LinkedIn messaging, etc.) render
// overlays inside web components, which document.querySelectorAll cannot see.
function* deepElements(root: ParentNode): Generator<HTMLElement> {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    yield el;
    if (el.shadowRoot) yield* deepElements(el.shadowRoot);
  }
}

// Elements we hid, tracked so we can restore them even inside shadow roots (a main-document
// querySelectorAll / CSS rule cannot reach shadow DOM). Inline display:none works everywhere.
const hiddenEls: Array<{ el: HTMLElement; prevDisplay: string }> = [];
const hiddenSet = new Set<HTMLElement>();

// Persistent CSS rules that hide overlays by their stable id/class — survives framework
// re-renders/re-creations. Injected into the element's OWN root (a shadow root or the document),
// because a document stylesheet rule cannot style elements inside a shadow root (encapsulation).
const hideRoots = new Map<Document | ShadowRoot, { sels: Set<string>; style: HTMLStyleElement }>();

function selectorFor(el: HTMLElement): string | null {
  try {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const cls = Array.from(el.classList).slice(0, 3).filter(Boolean).map((c) => `.${CSS.escape(c)}`).join('');
    return cls || null;
  } catch {
    return null;
  }
}

function registerHideRule(el: HTMLElement): void {
  const sel = selectorFor(el);
  if (!sel) return;
  const rootNode = el.getRootNode();
  const root: Document | ShadowRoot = rootNode instanceof ShadowRoot ? rootNode : document;
  let entry = hideRoots.get(root);
  if (!entry) {
    const style = document.createElement('style');
    style.setAttribute('data-webclip-hide-style', '');
    (root instanceof ShadowRoot ? root : document.documentElement).appendChild(style);
    entry = { sels: new Set<string>(), style };
    hideRoots.set(root, entry);
  }
  if (!entry.sels.has(sel)) {
    entry.sels.add(sel);
    entry.style.textContent = `${Array.from(entry.sels).join(',')}{display:none !important;}`;
  }
}

function clearHideRules(): void {
  for (const { style } of hideRoots.values()) style.remove();
  hideRoots.clear();
}

// If `el` lives inside a shadow root, hide the light-DOM shadow HOST instead — hiding the whole
// web component is reliable (our document rule reaches it, and a framework re-rendering the shadow
// internals can't un-hide the host). Guard: never retarget to a host that wraps the scroll panel
// or is <html>/<body> (that would blank the capture).
function hideTarget(el: HTMLElement, scroller: HTMLElement | null): HTMLElement {
  const root = el.getRootNode();
  if (root instanceof ShadowRoot && root.host instanceof HTMLElement) {
    const host = root.host;
    if (host !== document.documentElement && host !== document.body && !(scroller && host.contains(scroller))) {
      return host;
    }
  }
  return el;
}

function hideEl(el: HTMLElement, attr: string): void {
  if (!hiddenSet.has(el)) {
    hiddenSet.add(el);
    hiddenEls.push({ el, prevDisplay: el.style.getPropertyValue('display') });
  }
  el.setAttribute(attr, '');
  el.style.setProperty('display', 'none', 'important'); // immediate; works inside shadow DOM
  registerHideRule(el); // persistent, scoped to the element's own root (shadow-aware)
}

function restoreHidden(): void {
  for (const { el, prevDisplay } of hiddenEls) {
    el.removeAttribute(FIXED_ATTR);
    el.removeAttribute(DECLUTTER_ATTR);
    if (prevDisplay) el.style.setProperty('display', prevDisplay);
    else el.style.removeProperty('display');
  }
  hiddenEls.length = 0;
  hiddenSet.clear();
  clearHideRules();
}

function isStuck(el: HTMLElement, cs: CSSStyleDeclaration): boolean {
  if (cs.position !== 'sticky') return cs.position === 'fixed';
  const rect = el.getBoundingClientRect();
  const top = parseFloat(cs.top);
  const bottom = parseFloat(cs.bottom);
  if (!Number.isNaN(top) && Math.abs(rect.top - top) < 2) return true;
  if (!Number.isNaN(bottom) && Math.abs(window.innerHeight - rect.bottom - bottom) < 2) return true;
  return false;
}

function injectStabilizationStyle(suppressAnimations: boolean): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    'html{scroll-behavior:auto !important;}' +
    // Disable scroll-anchoring: it silently shifts scrollTop when content above the viewport
    // reflows mid-capture, which knocks a thin band out of alignment between adjacent tiles.
    '*{overflow-anchor:none !important;}' +
    // Hide scrollbars so they don't repeat down every captured tile.
    '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}' +
    '*{scrollbar-width:none !important;}' +
    `[${DECLUTTER_ATTR}],[${FIXED_ATTR}]{display:none !important;}` +
    (suppressAnimations
      ? '*,*::before,*::after{animation-play-state:paused !important;transition-duration:0s !important;caret-color:transparent !important;}'
      : '');
  document.documentElement.appendChild(style);
}

const controller: Controller = {
  prepare(opts: PrepareOptions): void {
    clearPickOutline(); // keep the pick marker, but never let the selection outline into the capture
    const de = document.documentElement;
    de.setAttribute(SCROLL_ATTR, `${window.scrollX},${window.scrollY}`);
    de.setAttribute(SB_ATTR, de.style.getPropertyValue('scroll-behavior'));
    de.style.setProperty('scroll-behavior', 'auto');
    const s = resolveScroller();
    originalScrollerTop = s ? s.scrollTop : 0;
    injectStabilizationStyle(opts.suppressAnimations);
    if (opts.declutter) this.declutter(true);
  },

  measure(): PageMetrics {
    return {
      viewportWidthCss: window.innerWidth,
      viewportHeightCss: window.innerHeight,
      documentWidthCss: docWidth(),
      documentHeightCss: docHeight(),
      initialScrollX: window.scrollX,
      initialScrollY: window.scrollY,
      devicePixelRatio: window.devicePixelRatio || 1,
    };
  },

  scrollContext(): ScrollContext {
    const fullViewportWidth = window.innerWidth;
    const fullViewportHeight = window.innerHeight;
    const s = resolveScroller();
    if (!s) {
      return {
        scrollHeight: docHeight(),
        clientHeight: fullViewportHeight,
        scrollTop: window.scrollY,
        rectTop: 0,
        rectLeft: 0,
        rectWidth: fullViewportWidth,
        rectHeight: fullViewportHeight,
        fullViewportWidth,
        fullViewportHeight,
        isWindow: true,
      };
    }
    const r = s.getBoundingClientRect();
    const rectTop = Math.max(0, r.top);
    const rectLeft = Math.max(0, r.left);
    const rectHeight = Math.max(0, Math.min(fullViewportHeight, r.bottom) - rectTop);
    const rectWidth = Math.max(0, Math.min(fullViewportWidth, r.right) - rectLeft);
    return {
      scrollHeight: s.scrollHeight,
      clientHeight: s.clientHeight,
      scrollTop: s.scrollTop,
      rectTop,
      rectLeft,
      rectWidth,
      rectHeight,
      fullViewportWidth,
      fullViewportHeight,
      isWindow: false,
    };
  },

  scrollTo(x: number, y: number): { scrollX: number; scrollY: number } {
    const s = resolveScroller();
    if (s) {
      s.scrollLeft = x;
      s.scrollTop = y;
      return { scrollX: s.scrollLeft, scrollY: s.scrollTop };
    }
    window.scrollTo({ left: x, top: y, behavior: 'auto' });
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  },

  setFixedHidden(hidden: boolean): number {
    if (!hidden) {
      restoreHidden();
      return 0;
    }
    const scroller = resolveScroller();
    let n = 0;
    if (scroller) {
      // Panel mode: hide (a) positioned overlays OUTSIDE the panel that overlap its box (messaging/
      // chat/promos), and (b) sticky/fixed pins INSIDE the panel (e.g. a "search alert" footer bar)
      // that don't scroll with content and so repeat in every tile.
      const box = scroller.getBoundingClientRect();
      for (const el of deepElements(document.body)) {
        if (el === scroller || el.contains(scroller)) continue; // skip the panel + its ancestors
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        let hide = false;
        if (scroller.contains(el)) {
          hide = cs.position === 'sticky' || cs.position === 'fixed'; // a pin inside the panel
        } else {
          const positioned = cs.position === 'fixed' || cs.position === 'absolute' || cs.position === 'sticky';
          hide = positioned && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
        }
        if (hide) {
          hideEl(hideTarget(el, scroller), FIXED_ATTR);
          n++;
        }
      }
    } else {
      // Document-scroll mode: hide fixed + stuck-sticky (repeating headers/chat), keep in-flow content.
      for (const el of deepElements(document.body)) {
        const cs = getComputedStyle(el);
        const fixedOrStuck = cs.position === 'fixed' || (cs.position === 'sticky' && isStuck(el, cs));
        if (!fixedOrStuck || cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) {
          hideEl(hideTarget(el, null), FIXED_ATTR);
          n++;
        }
      }
    }
    return n;
  },

  declutter(on: boolean): void {
    if (!on) {
      restoreHidden();
      return;
    }
    const sel = CLUTTER_SELECTORS.join(',');
    const scroller = resolveScroller();
    for (const el of deepElements(document.body)) {
      if (scroller && (el === scroller || el.contains(scroller))) continue; // never hide the panel
      let match = false;
      try {
        match = el.matches(sel);
      } catch {
        match = false;
      }
      if (!match) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 1 && r.height > 1) hideEl(hideTarget(el, scroller), DECLUTTER_ATTR);
    }
  },

  // Enter "pick a section" mode: highlight the scroll pane under the cursor; on click, mark it as
  // the pane to capture and notify the service worker (or cancel on Esc / non-scrollable click).
  startPick(): void {
    if (document.querySelector('[data-webclip-picker]')) return; // already picking
    const highlight = document.createElement('div');
    highlight.setAttribute('data-webclip-picker', '');
    const hs = highlight.style;
    hs.position = 'fixed';
    hs.zIndex = '2147483647';
    hs.pointerEvents = 'none';
    hs.boxSizing = 'border-box';
    hs.border = '2px solid #2f6df6';
    hs.background = 'rgba(47,109,246,0.12)';
    hs.display = 'none';
    document.documentElement.appendChild(highlight);
    let current: HTMLElement | null = null;

    const onMove = (e: MouseEvent): void => {
      current = scrollableAncestor(e.target as Element);
      const box = current ? current.getBoundingClientRect() : null;
      if (box && box.width > 0 && box.height > 0) {
        hs.display = 'block';
        hs.left = `${box.left}px`;
        hs.top = `${box.top}px`;
        hs.width = `${box.width}px`;
        hs.height = `${box.height}px`;
      } else {
        hs.display = 'none';
      }
    };
    const cleanup = (): void => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      highlight.remove();
      globalThis.__webclipCancelPick = undefined;
    };
    globalThis.__webclipCancelPick = cleanup; // allow the popup/worker to cancel without a page click
    const onClick = (e: MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const target = current ?? scrollableAncestor(e.target as Element);
      cleanup();
      if (target) {
        markPicked(target); // select the pane (outline it); capture happens later via the popup
        void chrome.runtime.sendMessage({ type: 'PANE_PICKED' }).catch(() => undefined);
      } else {
        void chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => undefined);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        cleanup();
        void chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => undefined);
      }
    };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  },

  clearPick(): void {
    clearPicked();
  },
  hasPick(): boolean {
    return document.querySelector(`[${PICKED_ATTR}]`) !== null;
  },
  collectLinks(): PageLink[] {
    // Positions of meaningful <a href> targets in the captured panel's content coordinates (CSS px,
    // origin = panel top-left), so the renderer can lay clickable link annotations over the raster.
    // Call while the panel is at the top of its content (post-warmup). Virtualized feeds that unload
    // off-screen content will only yield the links currently in the DOM — best-effort.
    const ctx = this.scrollContext();
    const s = resolveScroller();
    const scrollTop = s ? s.scrollTop : window.scrollY;
    const out: PageLink[] = [];
    const anchors = document.querySelectorAll('a[href]');
    for (let i = 0; i < anchors.length && out.length < 800; i++) {
      const a = anchors[i];
      if (!(a instanceof HTMLAnchorElement)) continue;
      const raw = a.getAttribute('href') || '';
      if (raw.startsWith('#')) continue; // same-page anchor — no meaning in a standalone PDF
      const href = a.href; // resolved absolute URL
      if (!/^(https?|mailto|tel):/i.test(href)) continue; // skip javascript:, data:, blob:, etc.
      const r = a.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.right < ctx.rectLeft || r.left > ctx.rectLeft + ctx.rectWidth) continue; // outside the captured panel
      const xCss = Math.max(0, r.left - ctx.rectLeft);
      const yCss = r.top - ctx.rectTop + scrollTop;
      if (yCss + r.height < 0) continue; // above the captured content
      out.push({ href, xCss, yCss, wCss: Math.min(r.width, ctx.rectWidth - xCss), hCss: r.height });
    }
    return out;
  },
  restore(): void {
    document.getElementById(STYLE_ID)?.remove();
    restoreHidden();
    clearPicked();
    const de = document.documentElement;
    const sb = de.getAttribute(SB_ATTR);
    if (sb !== null) {
      if (sb) de.style.setProperty('scroll-behavior', sb);
      else de.style.removeProperty('scroll-behavior');
      de.removeAttribute(SB_ATTR);
    }
    const scroll = de.getAttribute(SCROLL_ATTR);
    if (scroll !== null) {
      const [x, y] = scroll.split(',').map(Number);
      window.scrollTo({ left: x || 0, top: y || 0, behavior: 'auto' });
      de.removeAttribute(SCROLL_ATTR);
    }
    const s = resolveScroller();
    if (s) s.scrollTop = originalScrollerTop;
  },
};

globalThis.__webclipController = controller;
