// Injected page controller (WC-M3). Bundled as a classic (IIFE) content script and
// injected into the active tab's isolated world; subsequent executeScript({func}) calls
// invoke `globalThis.__webclipController`. Restore state lives in DOM attributes so it
// survives across separate injections/calls (§70). Every DOM change is reversible (§37).
import type { PageMetrics, PrepareOptions, ScrollContext, PageLink, RegionInfo, RegionTilePos, Anchor } from '../shared/types.js';
import { isFrameContentUncaptured } from '../shared/frames.js';
import type { FrameRect } from '../shared/frames.js';

const STYLE_ID = 'webclip-capture-style';
const DECLUTTER_ATTR = 'data-webclip-declutter'; // persistent hide for the whole capture
const FIXED_ATTR = 'data-webclip-fixed'; // per-tile fixed/sticky suppression (toggled by M4)
const SCROLL_ATTR = 'data-webclip-scroll';
const SB_ATTR = 'data-webclip-scroll-behavior';
const PICKED_ATTR = 'data-webclip-picked'; // user-selected scroll pane (overrides auto-detection)

// Conservative, high-signal clutter selectors (cookie/consent/ad banners + course-player nav chrome).
// Case-insensitive. Course players (Rise/SCORM) pin a hamburger / "menu" toggle and an EXIT bar that
// aren't part of any content section; strip them so a full-page/marked capture is clean.
const CLUTTER_SELECTORS = [
  '[id*="cookie" i]', '[class*="cookie" i]', '[aria-label*="cookie" i]',
  '[id*="consent" i]', '[class*="consent" i]',
  '[id*="gdpr" i]', '[class*="gdpr" i]',
  '[id*="onetrust" i]', '#onetrust-banner-sdk', '#onetrust-consent-sdk',
  'ins.adsbygoogle', '[class*="advert" i]', '[id*="cookie-banner" i]',
  // Course-player nav/menu/exit chrome — GENERIC substring patterns (not one site): matches Rise,
  // Storyline, generic LMS players. Paired with a text-based check below for "EXIT COURSE"-style labels.
  '[class*="courseexit" i]', '[class*="course-exit" i]', '[class*="exit-course" i]', '[class*="exitcourse" i]',
  '[class*="nav-control" i]', '[class*="nav-toggle" i]', '[class*="menu-toggle" i]', '[class*="page-menu" i]',
  '[class*="sidebar-toggle" i]', '[aria-controls*="nav-content" i]',
  '[aria-label*="navigation menu" i]', '[aria-label*="exit course" i]', '[aria-label*="exit lesson" i]',
];

// High-signal course-chrome BUTTON labels — matched by text (generic across players) for small button-like
// elements, so "EXIT COURSE" is stripped whatever its class name is. Kept specific to avoid content buttons.
const CHROME_TEXTS = new Set(['EXIT COURSE', 'EXIT LESSON', 'EXIT ACTIVITY', 'BACK TO COURSE', 'CLOSE NAVIGATION MENU', 'OPEN NAVIGATION MENU', 'EXIT AND CLOSE']);
function isChromeButton(el: HTMLElement, win: Window): boolean {
  const tag = el.tagName;
  const role = el.getAttribute('role');
  if (tag !== 'BUTTON' && tag !== 'A' && role !== 'button' && role !== 'link') return false;
  const txt = (el.textContent || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!txt || txt.length > 24 || !CHROME_TEXTS.has(txt)) return false;
  const r = el.getBoundingClientRect();
  const vpW = win.innerWidth || 1;
  const vpH = win.innerHeight || 1;
  return r.width > 1 && r.height > 1 && (r.width * r.height) / (vpW * vpH) <= 0.2; // small = chrome, not content
}

interface Controller {
  prepare(opts: PrepareOptions): void;
  measure(): PageMetrics;
  scrollContext(): ScrollContext;
  scrollTo(x: number, y: number): { scrollX: number; scrollY: number };
  setFixedHidden(hidden: boolean, barLikeOnly?: boolean): number;
  declutter(on: boolean): void;
  startPick(): void;
  clearPick(): void;
  hasPick(): boolean;
  startMark(): void;
  cancelMark(): void;
  useMarkedBlockAsScroller(): boolean;
  clearForcedScroller(): void;
  regionInfo(extraOverlapCss?: number): RegionInfo | null;
  regionPositionTile(i: number): RegionTilePos | null;
  collectLinks(): PageLink[];
  collectRegionLinks(): PageLink[];
  measureTopFrozenCss(): Promise<number>;
  collectAnchors(): Anchor[];
  collectTabPanels(): import('../shared/types.js').TabPanelExtent[];
  modalBands(): import('../shared/types.js').ModalBands | null;
  restore(): void;
}

const PICK_OUTLINE = 'data-webclip-pick-outline'; // marks the inline outline we add to the selected pane

/** All reachable same-origin frame contexts (recursively), each with the chain of <iframe>s from the
 *  top document down to it — so the picker can run inside frames and the caller can composite geometry. */
function sameOriginFrameContexts(): Array<{ doc: Document; win: Window; chain: HTMLIFrameElement[] }> {
  const out: Array<{ doc: Document; win: Window; chain: HTMLIFrameElement[] }> = [];
  const walk = (doc: Document, chain: HTMLIFrameElement[]): void => {
    for (const f of Array.from(doc.querySelectorAll('iframe'))) {
      let cd: Document | null = null;
      try {
        cd = f.contentDocument;
      } catch {
        cd = null;
      }
      if (cd && cd.body && f.contentWindow) {
        const next = [...chain, f];
        out.push({ doc: cd, win: f.contentWindow, chain: next });
        walk(cd, next);
      }
    }
  };
  walk(document, []);
  return out;
}
/** Run fn over the top document and every reachable same-origin frame document. */
function forEachPickerDoc(fn: (doc: Document) => void): void {
  fn(document);
  for (const { doc } of sameOriginFrameContexts()) fn(doc);
}

/** Give the selected pane a persistent outline so the user can see what will be captured, and clear it. */
function markPicked(el: HTMLElement): void {
  clearPicked();
  el.setAttribute(PICKED_ATTR, '');
  el.setAttribute(PICK_OUTLINE, el.style.outline || '');
  el.style.outline = '3px solid #2f6df6';
  el.style.outlineOffset = '-3px';
}
/** Remove just the selection OUTLINE (so it never appears in a capture) — keeps the pick marker.
 *  Searches the top document and every same-origin frame (a pane may be picked inside a frame). */
function clearPickOutline(): void {
  forEachPickerDoc((doc) =>
    doc.querySelectorAll(`[${PICK_OUTLINE}]`).forEach((e) => {
      const el = e as HTMLElement;
      const prev = el.getAttribute(PICK_OUTLINE) || '';
      el.style.outline = prev;
      if (!prev) el.style.removeProperty('outline');
      el.style.removeProperty('outline-offset');
      el.removeAttribute(PICK_OUTLINE);
    }),
  );
}
function clearPicked(): void {
  clearPickOutline();
  forEachPickerDoc((doc) => doc.querySelectorAll(`[${PICKED_ATTR}]`).forEach((e) => e.removeAttribute(PICKED_ATTR)));
}

// Active picker teardown callbacks — one per document the picker was installed into (top + frames).
let pickerCleanups: Array<() => void> = [];
function stopAllPickers(): void {
  for (const c of pickerCleanups) {
    try {
      c();
    } catch {
      /* frame may have navigated */
    }
  }
  pickerCleanups = [];
  globalThis.__webclipCancelPick = undefined;
}

// Install the "pick a section" picker into ONE document: a highlight overlay + hover/click/Esc handlers.
// Mouse events do not cross frame boundaries, so the picker is installed into each same-origin frame
// too (startPick), letting the user select a pane INSIDE a frame (e.g. a SCORM/Rise course). The chosen
// pane is marked in its own document; resolveScroller finds it across frames and captures via the chain.
function installPickerIn(doc: Document, win: Window, isFrame: boolean): void {
  if (doc.querySelector('[data-webclip-picker]')) return;
  const highlight = doc.createElement('div');
  highlight.setAttribute('data-webclip-picker', '');
  const hs = highlight.style;
  hs.position = 'fixed';
  hs.zIndex = '2147483647';
  hs.pointerEvents = 'none';
  hs.boxSizing = 'border-box';
  hs.border = '2px solid #2f6df6';
  hs.background = 'rgba(47,109,246,0.12)';
  hs.display = 'none';
  (doc.documentElement || doc.body).appendChild(highlight);
  // Pane under the cursor. Inside a frame, if no inner overflow-pane is found, fall back to the whole
  // frame document (its content scrolls at the document level — e.g. a Rise course) so the user can
  // still select "this frame's content".
  const paneFor = (t: Element | null): HTMLElement | null =>
    scrollableAncestor(t, win) ?? (isFrame ? (win.document.scrollingElement as HTMLElement | null) : null);
  const boxFor = (pane: HTMLElement): { left: number; top: number; width: number; height: number } =>
    pane === win.document.scrollingElement
      ? { left: 0, top: 0, width: win.innerWidth, height: win.innerHeight } // the frame viewport
      : pane.getBoundingClientRect();
  let current: HTMLElement | null = null;
  const onMove = (e: MouseEvent): void => {
    current = paneFor(e.target as Element);
    const box = current ? boxFor(current) : null;
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
  const onClick = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const target = current ?? paneFor(e.target as Element);
    stopAllPickers();
    if (target) {
      markPicked(target); // select the pane (outline it); capture happens later via the popup
      void chrome.runtime.sendMessage({ type: 'PANE_PICKED' }).catch(() => undefined);
    } else {
      void chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => undefined);
    }
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      stopAllPickers();
      void chrome.runtime.sendMessage({ type: 'PICK_CANCELLED' }).catch(() => undefined);
    }
  };
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  pickerCleanups.push(() => {
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    highlight.remove();
  });
}

// Nearest selectable pane of a hovered element (for the "Pick a section" picker). Prefers a genuinely
// scrollable ancestor; if none, falls back to the nearest designed scroll CONTAINER (overflow-y set)
// even when its content currently fits — so a distinct column/section can be picked and captured
// independently even before it has a scrollbar. (Auto-detection, resolveScroller, keeps its stricter
// scroll-range test; this relaxation is picker-only, where the user is choosing explicitly.)
function scrollableAncestor(el: Element | null, win: Window): HTMLElement | null {
  const doc = win.document;
  let node: HTMLElement | null = el && el.nodeType === 1 ? (el as HTMLElement) : null; // realm-agnostic
  let pane: HTMLElement | null = null;
  while (node && node !== doc.body && node !== doc.documentElement) {
    const cs = win.getComputedStyle(node);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'overlay') {
      if (node.scrollHeight - node.clientHeight > 20) return node; // genuinely scrollable → best pick
      // A scroll pane that just isn't long enough to scroll yet — remember the nearest sizeable one so
      // the user can still select it (min-size guard avoids picking a tiny overflow chip).
      if (!pane && node.clientHeight >= 40 && node.clientWidth >= 40) pane = node;
    }
    node = node.parentElement;
  }
  return pane; // null → the document/window scroll
}

// --- Section marking (WC-M11): capture a chosen content BLOCK (an accordion panel, a card) as one
// self-contained region, assembled without overlap. Sidesteps the viewport-stitch guesswork entirely. ---
let markedBlock: HTMLElement | null = null;
let markedWin: Window = window;
let markedChain: HTMLIFrameElement[] = [];
let markCleanups: Array<() => void> = [];
const REGION_TILE_OVERLAP_CSS = 48; // mirror DEFAULT_TILE_OVERLAP_CSS — overlap between region tiles for the seam matcher
let region = { widthCss: 0, heightCss: 0, tileHeightCss: 1, tileStepCss: 1, blockContentTop: 0 };

/** Sum of every frame offset in a chain — where the frame's viewport origin sits in the TOP viewport. */
function frameOffset(chain: HTMLIFrameElement[]): { left: number; top: number } {
  let left = 0;
  let top = 0;
  for (const f of chain) {
    const r = f.getBoundingClientRect();
    left += r.left;
    top += r.top;
  }
  return { left, top };
}

/** The sensible content BLOCK under the cursor to mark: the nearest substantial block-level ancestor
 *  (wide enough, tall enough) — the accordion panel / card, not a tiny inline span or the whole page. */
function blockFor(el: Element | null, win: Window): HTMLElement | null {
  let node: HTMLElement | null = el && el.nodeType === 1 ? (el as HTMLElement) : null;
  const vpW = win.innerWidth;
  let best: HTMLElement | null = null;
  while (node && node !== win.document.body && node !== win.document.documentElement) {
    const r = node.getBoundingClientRect();
    if (r.width >= vpW * 0.25 && r.height >= 24) {
      best = node;
      if (r.height >= 60) break; // a real content block — stop climbing
    }
    node = node.parentElement;
  }
  return best;
}

// --- Atlas anchors (WC-M12): section headers that a marked/snapped piece splices in at. The base and a
// marked section derive the SAME key from the same header element, so a confident match places the piece
// exactly; no match / ambiguous → the caller drops it. Selectors are generic across course players. ---
const ANCHOR_SEL = 'summary,[aria-expanded],h1,h2,h3,h4,h5,[role="heading"],.blocks-accordion__header,[class*="accordion" i] [class*="header" i],[class*="accordion" i] [class*="title" i]';
function anchorKeyOf(el: Element): string {
  return (el.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}
/** The section header a marked block belongs to (best-effort; '' if unsure → the piece won't be placed). */
// What headers a marked block spans (↑/↓ may make it cover several sections, or none). Returns every
// header key INSIDE the mark (DOM order) — used to locate + bound its replacement in the base — and, if
// the mark has no header of its own, the preceding section header (so it inserts under it, keeping it).
function markAnchorInfo(block: HTMLElement): { insideKeys: string[]; precedingKey: string } {
  const insideKeys: string[] = [];
  const seen = new Set<string>();
  const add = (el: Element): void => {
    const k = anchorKeyOf(el);
    if (k && !seen.has(k)) {
      seen.add(k);
      insideKeys.push(k);
    }
  };
  if (block.matches?.(ANCHOR_SEL)) add(block);
  for (const el of Array.from(block.querySelectorAll(ANCHOR_SEL))) add(el);
  let precedingKey = '';
  if (!insideKeys.length) {
    // The header may be a previous sibling of the block OR of an ANCESTOR (e.g. the block is the panel's
    // content div and the section header is the panel's previous sibling). Walk up, checking prior siblings.
    // Only a header that is a DIRECT previous sibling counts (an accordion's own header sits right before
    // its panel). We do NOT descend into a sibling with querySelector — that would grab a DISTANT section
    // heading (e.g. a tab widget whose panel's siblings are other panels/tabbars, with the heading far up),
    // which must instead be placed by its captured area, not right under that far heading.
    let node: HTMLElement | null = block;
    for (let up = 0; up < 6 && node && !precedingKey; up++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      for (let i = 0; i < 5 && sib; i++, sib = sib.previousElementSibling) {
        if (sib.matches?.(ANCHOR_SEL)) {
          const k = anchorKeyOf(sib);
          if (k) {
            precedingKey = k;
            break;
          }
        }
      }
    }
  }
  return { insideKeys, precedingKey };
}

// --- Tab-widget detection (WC-M12): course players (SCORM/Rise) show ONE tab panel at a time, keeping the
// others in the DOM but hidden. The base captures the DEFAULT (visible) tab; a mark of another tab must
// splice AFTER the default view, and a re-mark of the default must PATCH it in place (not duplicate). We
// detect the panel group generically: sibling elements that are structurally alike where exactly one is
// visible (the default) and the rest are hidden (the other tabs). No dependency on a specific framework. ---
function elHidden(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden';
}
function elVisibleBlock(el: HTMLElement, vpW: number): boolean {
  if (elHidden(el)) return false;
  const r = el.getBoundingClientRect();
  return r.height >= 24 && r.width >= vpW * 0.2; // a real panel, not an icon/label (off-screen is still fine)
}
function classTokens(el: Element): string[] {
  return (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean);
}
// Are a and b two panels of the SAME tab widget? Same tag AND a shared identity signal (ARIA role,
// a shared class token like .panel/.tab-pane, or a data-tab hook). Keeps the tabbar/nav out of the group.
function panelsAlike(a: HTMLElement, b: HTMLElement): boolean {
  if (a.tagName !== b.tagName) return false;
  const ra = a.getAttribute('role'), rb = b.getAttribute('role');
  if (ra && ra === rb) return true;
  const ta = classTokens(a), tb = classTokens(b);
  if (ta.length && ta.some((t) => tb.includes(t))) return true;
  if (a.hasAttribute('data-tab') && b.hasAttribute('data-tab')) return true;
  return false;
}
// The tab-panel group `panel` belongs to (DOM order), or null: >=2 alike siblings, exactly one visible.
function tabPanelGroupAround(panel: HTMLElement, vpW: number): HTMLElement[] | null {
  const parent = panel.parentElement;
  if (!parent) return null;
  const alike = Array.from(parent.children).filter((c): c is HTMLElement => c instanceof HTMLElement && panelsAlike(c, panel));
  if (alike.length < 2) return null;
  const visible = alike.filter((c) => elVisibleBlock(c, vpW));
  const hidden = alike.filter((c) => elHidden(c));
  if (visible.length === 1 && hidden.length >= 1) return alike; // one shown (default), the rest are other tabs
  return null;
}
// Walk up from a marked block to the tab PANEL it sits in (the block may be inner content), return its
// group + the panel node, or null when it isn't a tab widget.
function markedTabGroup(block: HTMLElement, vpW: number): { group: HTMLElement[]; panel: HTMLElement } | null {
  let node: HTMLElement | null = block;
  for (let up = 0; up < 5 && node; up++, node = node.parentElement) {
    const g = tabPanelGroupAround(node, vpW);
    if (g) return { group: g, panel: node };
  }
  return null;
}

/** Install the mark highlighter into one document: hover outlines the block; ↑/↓ grow/shrink the
 *  selection so the user gets EXACTLY the section (not a too-big container); click marks it. The whole
 *  block is captured on click — even the part below the fold — so no manual scroll tracking is needed. */
function installMarkIn(doc: Document, win: Window, chain: HTMLIFrameElement[]): void {
  if (doc.querySelector('[data-webclip-mark]')) return;
  const hl = doc.createElement('div');
  hl.setAttribute('data-webclip-mark', '');
  hl.setAttribute('data-webclip-ui', '');
  const s = hl.style;
  s.position = 'fixed';
  s.zIndex = '2147483647';
  s.pointerEvents = 'none';
  s.boxSizing = 'border-box';
  s.border = '2px solid #16a34a';
  s.background = 'rgba(22,163,74,0.14)';
  s.display = 'none';
  (doc.documentElement || doc.body).appendChild(hl);
  const label = doc.createElement('div');
  label.setAttribute('data-webclip-ui', '');
  label.setAttribute('data-webclip-mark-label', ''); // distinct marker so an orphan sweep removes it without touching the toolbar
  const ls = label.style;
  ls.position = 'fixed';
  ls.zIndex = '2147483647';
  ls.pointerEvents = 'none';
  ls.background = '#16a34a';
  ls.color = '#fff';
  ls.font = '11px system-ui, -apple-system, sans-serif';
  ls.padding = '2px 7px';
  ls.borderRadius = '4px';
  ls.whiteSpace = 'nowrap';
  ls.display = 'none';
  (doc.documentElement || doc.body).appendChild(label);

  let current: HTMLElement | null = null;
  let anchorEl: HTMLElement | null = null; // deepest element under the cursor — the target for ↓ (shrink)
  let locked = false; // false = hover-to-select; true = a section is selected, review by scrolling then capture
  const paint = (): void => {
    if (!current) {
      s.display = 'none';
      label.style.display = 'none';
      return;
    }
    const r = current.getBoundingClientRect(); // re-read every paint → the outline FOLLOWS the element on scroll
    s.display = 'block';
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    s.borderStyle = locked ? 'solid' : 'dashed';
    s.borderWidth = locked ? '3px' : '2px';
    const below = r.bottom > win.innerHeight + 2;
    const above = r.top < -2;
    const size = `${Math.round(r.width)}×${Math.round(r.height)}px`;
    label.style.display = 'block';
    label.style.left = `${Math.max(2, Math.min(r.left, win.innerWidth - 320))}px`;
    // keep the label on-screen even when the section top has scrolled above the viewport
    const labelTop = r.top < 22 ? 4 : r.top - 20;
    label.style.top = `${Math.max(4, Math.min(labelTop, win.innerHeight - 22))}px`;
    label.textContent = locked
      ? `✓ selected ${size}${below || above ? ' · scroll to review — whole section captured' : ''} · press m (or click/Enter) to capture · ↑/↓ resize · Esc`
      : `▤ ${size}${below ? ' · runs below' : ''} · press m (or click) to capture · ↑/↓ resize`;
  };
  const onMove = (e: MouseEvent): void => {
    if (locked) return; // selection is locked; ignore hover so it can be reviewed by scrolling
    if ((e.target as Element)?.closest?.('[data-webclip-ui]')) return; // never highlight our own toolbar
    anchorEl = e.target as HTMLElement;
    current = blockFor(anchorEl, win);
    paint();
  };
  const capture = (): void => {
    if (!current) return;
    markedBlock = current;
    markedWin = win;
    markedChain = chain;
    stopMark();
    void chrome.runtime.sendMessage({ type: 'REGION_MARKED' }).catch(() => undefined);
  };
  const onClick = (e: MouseEvent): void => {
    const target = e.target as Element;
    if (target?.closest?.('[data-webclip-ui]')) return; // let the WebClip toolbar buttons receive the click
    e.preventDefault();
    e.stopPropagation();
    if (!locked) {
      current = blockFor(target, win) ?? current;
      if (!current) return;
      locked = true; // first click SELECTS — review by scrolling, then click again / Enter to capture
      paint();
      return;
    }
    // locked: a click ON the selected section captures it; a click elsewhere re-selects there
    if (current && (current === target || current.contains(target))) capture();
    else {
      const next = blockFor(target, win);
      if (next) {
        current = next;
        paint();
      }
    }
  };
  const onScroll = (): void => {
    if (locked) paint(); // the outline tracks the section as the page scrolls
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (locked) {
        locked = false; // first Esc de-selects (back to hover); second cancels mark mode
        s.borderStyle = 'dashed';
        return;
      }
      stopMark();
      void chrome.runtime.sendMessage({ type: 'MARK_CANCELLED' }).catch(() => undefined);
      return;
    }
    // Capture the current selection with Enter OR a second 'm' (first m armed mark mode, second captures).
    if ((e.key === 'Enter' || e.key === 'm' || e.key === 'M') && current) {
      e.preventDefault();
      e.stopPropagation();
      capture();
      return;
    }
    if (!current) return;
    if (e.key === 'ArrowUp' || e.key === '+' || e.key === '=') {
      const p = current.parentElement;
      if (p && p !== doc.body && p !== doc.documentElement) {
        current = p;
        paint();
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (e.key === 'ArrowDown' || e.key === '-' || e.key === '_') {
      // step one level DOWN toward the element under the cursor (shrink the selection)
      if (anchorEl && current.contains(anchorEl) && anchorEl !== current) {
        let node: HTMLElement = anchorEl;
        while (node.parentElement && node.parentElement !== current) node = node.parentElement;
        if (node !== current) {
          current = node;
          paint();
          e.preventDefault();
          e.stopPropagation();
        }
      }
    }
  };
  // Cross-origin iframes (YouTube/Vimeo embeds) can't be reached by our click handler — a click starts
  // playing the video and the section can't be marked, and a playing video also corrupts the multi-tile
  // capture. During mark mode make cross-origin iframes click-transparent (pointer-events:none) so the
  // click lands on the SECTION containing the embed (markable) and the embed stays on its poster frame.
  // Same-origin frames (SCORM/Rise) keep pointer-events so their inner blocks stay selectable.
  const peDisabled: HTMLElement[] = [];
  for (const f of Array.from(doc.querySelectorAll('iframe'))) {
    let sameOrigin = false;
    try {
      sameOrigin = !!f.contentDocument;
    } catch {
      sameOrigin = false; // access threw → cross-origin
    }
    if (!sameOrigin) {
      const el = f as HTMLElement;
      el.setAttribute('data-webclip-pe', el.style.pointerEvents || ' '); // remember prior inline value
      el.style.pointerEvents = 'none';
      peDisabled.push(el);
    }
  }
  doc.addEventListener('mousemove', onMove, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', onScroll, true); // capture phase → catches scroll on any scroller/frame
  markCleanups.push(() => {
    doc.removeEventListener('mousemove', onMove, true);
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('keydown', onKey, true);
    win.removeEventListener('scroll', onScroll, true);
    for (const el of peDisabled) {
      const prev = el.getAttribute('data-webclip-pe');
      el.style.pointerEvents = prev === ' ' || prev === null ? '' : prev; // restore prior inline value
      el.removeAttribute('data-webclip-pe');
    }
    hl.remove();
    label.remove();
  });
}

function removeMarkOverlays(): void {
  // Remove the mark highlighter (+ its label) from the top doc AND every same-origin frame. Only OUR mark
  // overlay markers are targeted — never the snapshot toolbar — so it's safe to call defensively.
  const docs: Document[] = [document];
  for (const { doc } of sameOriginFrameContexts()) docs.push(doc);
  for (const d of docs) {
    for (const el of Array.from(d.querySelectorAll('[data-webclip-mark], [data-webclip-mark-label]'))) el.remove();
  }
}

function stopMark(): void {
  for (const c of markCleanups) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  markCleanups = [];
  // Belt-and-suspenders: a lost cleanup (frame re-parented, teardown raced) must never strand a green
  // selection on the page. Sweep any orphaned mark overlay so stopMark always returns to a clean slate.
  try {
    removeMarkOverlays();
  } catch {
    /* ignore */
  }
  globalThis.__webclipCancelPick = undefined;
}

/** The block's scroll container (a pane, or the frame/document scroller) + its viewport metrics. When the
 *  marked block IS its own scroll container, `scrollableAncestor` returns the block itself (it tests the
 *  element before climbing), so `pane === markedBlock` — regionInfo uses that to tile its full scrollHeight. */
function blockScroller(): { pane: HTMLElement | null; win: Window; vpTopCss: number; vpHeightCss: number; scrollTop: number } {
  const win = markedWin;
  const pane = markedBlock ? scrollableAncestor(markedBlock, win) : null;
  if (pane) {
    const r = pane.getBoundingClientRect();
    return { pane, win, vpTopCss: r.top, vpHeightCss: pane.clientHeight, scrollTop: pane.scrollTop };
  }
  return { pane: null, win, vpTopCss: 0, vpHeightCss: win.innerHeight, scrollTop: win.scrollY };
}

// The active scroller: null = the document/window; otherwise the dominant inner scroll panel.
// Resolved once per injection (module scope survives within a single capture).
let scrollerEl: HTMLElement | null = null;
let scrollerResolved = false;
let originalScrollerTop = 0;
// The chain of same-origin <iframe>s we descended into to reach the active scroller (WC-M9 + nested).
// Empty = the scroller (if any) is in the top document. The scroller lives in the LAST frame's document;
// its geometry is frame-relative, so scrollContext/collectLinks composite it against the innermost
// frame's box in the TOP viewport (sum of each frame's offset — intermediate frames don't scroll).
let frameChain: HTMLIFrameElement[] = [];
/** The innermost descended frame (where the active scroller lives), or null if none. */
function activeFrame(): HTMLIFrameElement | null {
  return frameChain.length ? frameChain[frameChain.length - 1] : null;
}
/** The active in-frame scroller's box in the TOP viewport, clamped to it (CSS px). Composites every
 *  frame offset in the chain; for the whole-frame scroller it uses the innermost frame's size, for a
 *  picked panel inside the frame it uses the panel's own (frame-relative) rect. */
function scrollerBoxInTopViewport(s: HTMLElement, isFrameDoc: boolean): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  for (const f of frameChain) {
    const r = f.getBoundingClientRect();
    left += r.left;
    top += r.top;
  }
  let w: number;
  let h: number;
  if (isFrameDoc) {
    const inner = frameChain[frameChain.length - 1].getBoundingClientRect();
    w = inner.width;
    h = inner.height;
  } else {
    const pr = s.getBoundingClientRect(); // panel rect within the innermost frame's viewport
    left += pr.left;
    top += pr.top;
    w = pr.width;
    h = pr.height;
  }
  const rectLeft = Math.max(0, left);
  const rectTop = Math.max(0, top);
  return {
    left: rectLeft,
    top: rectTop,
    width: Math.max(0, Math.min(window.innerWidth, left + w) - rectLeft),
    height: Math.max(0, Math.min(window.innerHeight, top + h) - rectTop),
  };
}

function resolveScroller(): HTMLElement | null {
  if (scrollerResolved) return scrollerEl;
  scrollerResolved = true;
  frameChain = []; // cleared on every fresh resolve; rebuilt if we descend into frames
  // A user-picked pane (via "Pick a section") overrides auto-detection. It may live in the top document
  // or inside a same-origin frame — if the latter, record the frame chain so geometry composites right.
  const topPicked = document.querySelector(`[${PICKED_ATTR}]`);
  if (topPicked instanceof HTMLElement) {
    scrollerEl = topPicked;
    return topPicked;
  }
  for (const { doc, chain } of sameOriginFrameContexts()) {
    const p = doc.querySelector(`[${PICKED_ATTR}]`);
    if (p) {
      frameChain = chain;
      scrollerEl = p as HTMLElement;
      return scrollerEl;
    }
  }
  // An open MODAL/DIALOG takes over the viewport and dims the page behind it — capture IT, not the (still
  // tall) background document that would otherwise tile behind the frozen dialog. Prefer the modal's own
  // inner scroll pane so its full, scrollable content is captured; if it doesn't scroll, capture the modal
  // box itself. (Checked BEFORE the document-scroll test below, which the tall background would trip.)
  const modal = findOpenModal();
  if (modal) {
    scrollerEl = largestScrollPanelIn(modal) ?? modal;
    return scrollerEl;
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
  if (best) {
    scrollerEl = best;
    return best;
  }
  // Nothing in the top document scrolls: the real content may live inside a dominant, same-origin
  // <iframe> (SCORM/LMS course players, embedded viewers). Descend into it (WC-M9). Cross-origin or
  // unreachable frames stay out of scope (DEV-08 disclosure covers them).
  scrollerEl = resolveFrameScroller();
  return scrollerEl;
}

const MAX_FRAME_DEPTH = 4; // SCORM/Rise nests up to ~3 same-origin frames (scorm -> driver -> content)

// Recursively descend through dominant, same-origin, reachable <iframe>s to find genuinely scrollable
// content, building `frameChain` as the path. Returns the inner scroller, or null (leaving frameChain
// empty) if nothing scrollable is reachable — so the caller falls back to window capture + the honest
// DEV-08 disclosure and never captures a non-scrolling shell.
function resolveFrameScroller(): HTMLElement | null {
  return descendForScroller(document, 0);
}

// A TRUE modal only: `aria-modal="true"` or a top-layer <dialog> opened with showModal() (`:modal`). A
// bare `role="dialog"` is NOT enough — SPA side-panels (e.g. the ChatGPT canvas), popovers and menus use
// it without being modal, and hijacking the capture onto them surprised users. LinkedIn's Easy Apply and
// other real modals set aria-modal, so they still qualify.
function isTrueModal(el: HTMLElement): boolean {
  if (el.getAttribute('aria-modal') === 'true') return true;
  try {
    return el.matches(':modal'); // open <dialog> in the top layer
  } catch {
    return false; // :modal unsupported in this engine
  }
}
// The largest visibly-open TRUE MODAL on screen, or null. Pierces shadow. A modal takes over the viewport
// and dims the page behind it, so a full-page capture must target the modal — not the (still tall)
// background document, which would otherwise tile behind the frozen dialog. Small pop-overs and
// off-screen/hidden dialogs are filtered by the size + on-screen tests.
function findOpenModal(): HTMLElement | null {
  const vpW = window.innerWidth || 1;
  const vpH = window.innerHeight || 1;
  let best: HTMLElement | null = null;
  let bestArea = 0;
  for (const el of deepElements(document.body)) {
    if (!isTrueModal(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < vpW * 0.3 || r.height < vpH * 0.25) continue; // a real dialog, not a small pop-over/toast
    if (r.bottom <= 0 || r.top >= vpH || r.right <= 0 || r.left >= vpW) continue; // must be on screen
    const area = r.width * r.height;
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }
  return best;
}

/** Largest genuinely-scrollable pane WITHIN a subtree (pierces shadow) — e.g. a modal's content scroller. */
function largestScrollPanelIn(root: HTMLElement): HTMLElement | null {
  const rootH = Math.max(1, root.getBoundingClientRect().height);
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of deepElements(root)) {
    if (el.scrollHeight - el.clientHeight <= 40) continue;
    if (el.clientHeight < rootH * 0.3) continue; // a real content pane, not a tiny inset
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const score = el.clientWidth * el.clientHeight;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/** Largest genuinely-scrollable panel inside a document (excludes the document scroller itself). */
function largestScrollPanel(doc: Document, win: Window): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('*'))) {
    if (el.scrollHeight - el.clientHeight <= 40) continue;
    if (el.clientHeight < win.innerHeight * 0.4) continue;
    const oy = win.getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const score = el.clientWidth * el.clientHeight;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

function descendForScroller(doc: Document, depth: number): HTMLElement | null {
  if (depth >= MAX_FRAME_DEPTH) return null;
  const parentWin = doc.defaultView;
  if (!parentWin) return null;
  const vw = parentWin.innerWidth;
  const vh = parentWin.innerHeight;
  // Pick the most dominant reachable same-origin iframe in this document.
  let bestFrame: HTMLIFrameElement | null = null;
  let bestCoverH = 0;
  for (const f of Array.from(doc.querySelectorAll('iframe'))) {
    const r = f.getBoundingClientRect();
    const coverW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const coverH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (coverH < vh * 0.6 || coverW < vw * 0.4) continue; // must dominate (matches the DEV-08 heuristic)
    let cdoc: Document | null = null;
    try {
      cdoc = f.contentDocument;
    } catch {
      cdoc = null; // cross-origin: not script-accessible
    }
    if (!cdoc || !cdoc.body || !f.contentWindow) continue;
    if (coverH > bestCoverH) {
      bestCoverH = coverH;
      bestFrame = f;
    }
  }
  if (!bestFrame) return null;
  const cdoc = bestFrame.contentDocument as Document;
  const cwin = bestFrame.contentWindow as Window;
  frameChain.push(bestFrame);
  const de = cdoc.scrollingElement as HTMLElement | null;
  if (de && de.scrollHeight - cwin.innerHeight > 4) return de; // this frame scrolls → capture it
  const panel = largestScrollPanel(cdoc, cwin);
  if (panel) return panel; // a scrollable panel inside this frame
  const deeper = descendForScroller(cdoc, depth + 1); // nested content one more level down
  if (deeper) return deeper;
  frameChain.pop(); // dead end — this frame branch has no reachable scrollable content
  return null;
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

// Rendered boxes of top-level <iframe> elements — measurable even when the frame's content is not
// script-accessible. Used to detect a page whose real content is trapped in a frame we can't reach
// (DESIGN §22); the pure decision lives in shared/frames.ts.
function collectFrameRects(): FrameRect[] {
  const out: FrameRect[] = [];
  for (const f of Array.from(document.querySelectorAll('iframe'))) {
    const r = f.getBoundingClientRect();
    out.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
  }
  return out;
}

// Depth-first walk that PIERCES open shadow roots — modern apps (LinkedIn messaging, etc.) render
// overlays inside web components, which document.querySelectorAll cannot see.
function* deepElements(root: ParentNode): Generator<HTMLElement> {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    yield el;
    if (el.shadowRoot) yield* deepElements(el.shadowRoot);
  }
}

// A clickable embed (YouTube/Vimeo iframe) → its canonical page URL, so the video thumbnail becomes a
// clickable link in the PDF. Any other http(s) iframe links to its own source. Returns null for non-embeds.
function embedHref(el: HTMLElement): string | null {
  if (el.localName !== 'iframe') return null;
  const src = (el as HTMLIFrameElement).getAttribute('src') || '';
  if (!/^https?:/i.test(src)) return null;
  let m = src.match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/i);
  if (m) return 'https://www.youtube.com/watch?v=' + m[1];
  m = src.match(/player\.vimeo\.com\/video\/(\d+)/i);
  if (m) return 'https://vimeo.com/' + m[1];
  return src; // any other embed → link to its source page
}

// Link TARGETS under `root`, PIERCING open shadow roots — YouTube/modern SPAs render their links inside
// web components (shadow DOM), which querySelectorAll('a[href]') misses entirely. Collects BOTH <a href>
// anchors AND media embeds (iframes → embed:<url>), so a page's text links, image links, AND video embeds
// all become clickable. Capped to bound cost on huge pages.
function deepLinkTargets(root: ParentNode): Array<{ el: HTMLElement; embed: string | null }> {
  const out: Array<{ el: HTMLElement; embed: string | null }> = [];
  const walk = (r: ParentNode): void => {
    for (const el of Array.from(r.querySelectorAll<HTMLElement>('*'))) {
      // Match by tag name, NOT `instanceof`: an <a> inside a child frame belongs to that frame's realm,
      // so instanceof against the top window's constructor is FALSE (breaks frame links).
      if (el.localName === 'a' && el.hasAttribute('href')) out.push({ el, embed: null });
      else if (el.localName === 'iframe') {
        const h = embedHref(el);
        if (h) out.push({ el, embed: h });
      }
      if (out.length >= 4000) return;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

// The clickable box for a target: normally its own rect, but for an <a> that wraps only an image/media
// (a picture link) whose own rect collapses, fall back to the largest descendant box (the image itself).
function targetRect(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect();
  if (r.width >= 4 && r.height >= 4) return r;
  let best = r;
  for (const c of Array.from(el.querySelectorAll<HTMLElement>('img,canvas,video,picture,svg'))) {
    const cr = c.getBoundingClientRect();
    if (cr.width * cr.height > best.width * best.height) best = cr;
  }
  return best;
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

// A position:sticky element with a near-edge top/bottom pin offset WILL stick to the viewport during the
// scroll-and-tile capture and repeat in every tile — even though suppression runs at the top of the page,
// BEFORE it has stuck (where isStuck is false). GitHub's file header (breadcrumb + Preview/Code/Blame),
// LinkedIn's thin progress bar, etc. are exactly this: `top:0` (or a small offset) below other content.
// Catch them by DESIGN, not current state. Callers still gate on bar-like so tall sticky content is kept.
function pinsNearEdge(cs: CSSStyleDeclaration, win: Window): boolean {
  if (cs.position !== 'sticky') return false;
  const vpH = win.innerHeight || 1;
  const near = 0.25 * vpH; // "pins near an edge" — a header/footer/progress strip, not a mid-viewport sticky
  const top = parseFloat(cs.top);
  const bottom = parseFloat(cs.bottom);
  return (!Number.isNaN(top) && top <= near) || (!Number.isNaN(bottom) && bottom <= near);
}

function injectStabilizationStyle(suppressAnimations: boolean, doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    'html{scroll-behavior:auto !important;}' +
    // Disable scroll-anchoring: it silently shifts scrollTop when content above the viewport
    // reflows mid-capture, which knocks a thin band out of alignment between adjacent tiles.
    '*{overflow-anchor:none !important;}' +
    // Hide scrollbars so they don't repeat down every captured tile — and, inside a captured iframe,
    // so the moving scrollbar thumb does not confuse the tile-overlap pixel matcher.
    '::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important;}' +
    '*{scrollbar-width:none !important;}' +
    // Never let WebClip's own transient UI (the "section selected" toast, etc.) into a capture, even
    // if the user presses Capture before it auto-dismisses. It is appended to <html>, so the per-tile
    // fixed-element hider (which walks <body>) would otherwise miss it.
    `[${DECLUTTER_ATTR}],[${FIXED_ATTR}],[data-webclip-ui]{display:none !important;}` +
    (suppressAnimations
      ? '*,*::before,*::after{animation-play-state:paused !important;transition-duration:0s !important;caret-color:transparent !important;}'
      : '');
  (doc.documentElement || doc.body || doc).appendChild(style);
}

// Reversible expand of collapsible sections (opt-in). Records each change so restore() can undo it.
type ExpandRecord =
  | { kind: 'details'; el: HTMLDetailsElement }
  | { kind: 'hidden'; el: HTMLElement }
  | { kind: 'aria'; el: Element; prev: string }
  | { kind: 'click'; el: HTMLElement };
const expandRecords: ExpandRecord[] = [];

// A trigger is safe to CLICK-expand only if it is clearly a content-accordion header — never a nav
// menu, tab, combobox, or cookie/consent control (clicking those navigates or reflows and breaks the
// capture, as seen on the Wind River player). Requires an "accordion" class (Articulate Rise uses
// `blocks-accordion__header`, verified live) and excludes OneTrust + navigation.
function isSafeAccordionTrigger(btn: Element): boolean {
  const cls = (btn.getAttribute('class') || '').toLowerCase();
  if (!/accordion/.test(cls)) return false;
  if (/onetrust|(?:^|\s)ot-/.test(cls)) return false;
  if (btn.hasAttribute('ot-accordion')) return false;
  try {
    if (btn.closest('nav,[role="navigation"],[role="menu"],[role="menubar"],[role="tablist"],[id*="onetrust" i],[class*="onetrust" i]')) return false;
  } catch {
    /* :is/closest selector unsupported — fall through */
  }
  return true;
}

// Force collapsible sections open in one document. Realm-agnostic (elements inside a same-origin frame
// belong to the frame's realm, so `instanceof` is avoided). Handles, in order of safety:
//  1. native <details> — set open.
//  2. a collapsed `aria-expanded` disclosure controlling a [hidden] panel — reveal by attribute, no
//     click (also keeps EXCLUSIVE [hidden] accordions all-open, since we never re-trigger their JS).
//  3. otherwise, ONLY a clearly content-accordion header (isSafeAccordionTrigger — e.g. Articulate
//     Rise `blocks-accordion__header`) — CLICK it so the page runs its own expand. Never nav/menu/tab/
//     cookie controls: clicking those navigates/reflows and breaks the capture (Wind River regression).
function expandInDoc(doc: Document): void {
  doc.querySelectorAll('details:not([open])').forEach((el) => {
    expandRecords.push({ kind: 'details', el: el as HTMLDetailsElement });
    (el as HTMLDetailsElement).open = true;
  });
  doc.querySelectorAll('[aria-expanded="false"]').forEach((btn) => {
    const controls = btn.getAttribute('aria-controls');
    let revealedHidden = false;
    if (controls) {
      for (const id of controls.split(/\s+/)) {
        const panel = doc.getElementById(id);
        if (panel && panel.hasAttribute('hidden')) {
          expandRecords.push({ kind: 'hidden', el: panel });
          panel.removeAttribute('hidden');
          revealedHidden = true;
        }
      }
    }
    if (revealedHidden) {
      expandRecords.push({ kind: 'aria', el: btn, prev: 'false' });
      btn.setAttribute('aria-expanded', 'true');
    } else if (btn instanceof HTMLElement && isSafeAccordionTrigger(btn)) {
      expandRecords.push({ kind: 'click', el: btn });
      try {
        btn.click();
      } catch {
        /* a click handler threw — ignore; best-effort */
      }
    }
  });
}

function expandCollapsibleSections(): void {
  expandInDoc(document);
  // Reveal collapsibles inside every reachable same-origin frame at ANY depth — SCORM/Rise nests the
  // lesson (and its accordions) ~3 frames deep, so a single level is not enough.
  for (const { doc } of sameOriginFrameContexts()) expandInDoc(doc);
}

function restoreExpanded(): void {
  // Undo in reverse (LIFO) so nested toggles unwind cleanly.
  for (let i = expandRecords.length - 1; i >= 0; i--) {
    const rec = expandRecords[i];
    if (rec.kind === 'details') rec.el.open = false;
    else if (rec.kind === 'hidden') rec.el.setAttribute('hidden', '');
    else if (rec.kind === 'aria') rec.el.setAttribute('aria-expanded', rec.prev);
    else {
      // We clicked this accordion header to expand it; click again to toggle it back (best-effort).
      try {
        rec.el.click();
      } catch {
        /* ignore */
      }
    }
  }
  expandRecords.length = 0;
}

const controller: Controller = {
  prepare(opts: PrepareOptions): void {
    clearPickOutline(); // keep the pick marker, but never let the selection outline into the capture
    // Fresh scroller resolution per capture (a reused injected instance must not keep stale frame state).
    // resolveScroller() clears frameChain on re-resolve, so we only invalidate the cache here.
    scrollerResolved = false;
    scrollerEl = null;
    const de = document.documentElement;
    de.setAttribute(SCROLL_ATTR, `${window.scrollX},${window.scrollY}`);
    de.setAttribute(SB_ATTR, de.style.getPropertyValue('scroll-behavior'));
    de.style.setProperty('scroll-behavior', 'auto');
    // Expand BEFORE resolving the scroller / measuring, so revealed content counts toward the height.
    if (opts.expandCollapsible) expandCollapsibleSections();
    const s = resolveScroller();
    originalScrollerTop = s ? s.scrollTop : 0;
    injectStabilizationStyle(opts.suppressAnimations);
    // Stabilize the captured iframe too (hide its scrollbar, disable smooth-scroll / scroll-anchoring),
    // so the frame's own scrollbar doesn't leak into the crop or confuse the tile-overlap matcher.
    for (const f of frameChain) if (f.contentDocument) injectStabilizationStyle(opts.suppressAnimations, f.contentDocument);
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
    const inner = activeFrame();
    if (s && inner && inner.contentWindow) {
      // In-frame scroller (WC-M9 + nested): the scroller's own geometry drives the tiling, but the CROP
      // box is the scroller's box composited into the TOP viewport (where its pixels land in the tab
      // shot) — the sum of every frame offset in the chain (+ the panel's own rect if a panel was picked).
      const isFrameDoc = s === inner.contentDocument?.scrollingElement;
      const box = scrollerBoxInTopViewport(s, isFrameDoc);
      return {
        scrollHeight: s.scrollHeight,
        clientHeight: isFrameDoc ? inner.contentWindow.innerHeight : s.clientHeight,
        scrollTop: s.scrollTop,
        rectTop: box.top,
        rectLeft: box.left,
        rectWidth: box.width,
        rectHeight: box.height,
        fullViewportWidth,
        fullViewportHeight,
        isWindow: false,
        frameContentUncaptured: false, // we ARE capturing the frame
      };
    }
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
        frameContentUncaptured: isFrameContentUncaptured({
          docHeight: docHeight(),
          viewportWidth: fullViewportWidth,
          viewportHeight: fullViewportHeight,
          frameRects: collectFrameRects(),
        }),
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

  setFixedHidden(hidden: boolean, barLikeOnly = false): number {
    if (!hidden) {
      restoreHidden();
      return 0;
    }
    // A "bar-like" element is thin CHROME (a header/nav/footer/progress strip) — small area AND at
    // least one short dimension. Content wrappers fill most of the viewport, so this NEVER hides them.
    // Course players (Rise/SCORM) lay their MAIN content out with position:fixed/sticky, so hiding
    // fixed/sticky indiscriminately blanks the page — barLikeOnly is the guard that prevents that.
    const isBarLike = (r: DOMRect, win: Window): boolean => {
      const vpW = win.innerWidth || 1;
      const vpH = win.innerHeight || 1;
      const areaRatio = (r.width * r.height) / (vpW * vpH);
      return areaRatio <= 0.33 && (r.height <= 0.25 * vpH || r.width <= 0.25 * vpW);
    };
    // C3 contract (WC-M13 P3): suppression is scoped to the ACTIVE scroller — the one being tiled. During a
    // MARK, that is the marked block's own scroller (blockScroller), NOT the page's dominant pane
    // (resolveScroller), so a sticky bar inside the marked pane is stripped and the page's other panes are
    // left alone. Full-page / self-scroll marks (which swap the active scroller) already resolve to the right
    // element via resolveScroller. Falls back to the auto scroller when not marking.
    const scroller = markedBlock ? (blockScroller().pane ?? resolveScroller()) : resolveScroller();
    let n = 0;
    // A region MARK inside a same-origin frame descends via markedChain (NOT frameChain / the scroller-based
    // walk below), so the frame's OWN fixed/sticky bar-like chrome — a course player's progress/accent bar —
    // is never found there and repeats in every mark tile. Scan the marked block's frame chain directly and
    // hide that chrome (bar-like only, so a full-viewport content wrapper is never blanked).
    for (const f of markedChain) {
      const fdoc = f.contentDocument;
      const fwin = f.contentWindow;
      if (!fdoc?.body || !fwin) continue;
      for (const el of Array.from(fdoc.body.querySelectorAll<HTMLElement>('*'))) {
        const cs = fwin.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        if (!isBarLike(r, fwin)) continue;
        hideEl(el, FIXED_ATTR);
        n++;
      }
    }
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
        if (hide && barLikeOnly && !isBarLike(r, window)) hide = false; // never hide a content block
        if (hide) {
          hideEl(hideTarget(el, scroller), FIXED_ATTR);
          n++;
        }
      }
      // When the scroller is inside a frame (SCORM/Rise), also hide fixed/sticky chrome INSIDE the
      // frame chain — a course player's header ("EXIT COURSE"), nav, or progress bar pins to its
      // frame's viewport and so repeats in every tile/snapshot. Walk EVERY frame in the chain (the
      // chrome can live in a parent frame, not only the pane's own), realm-agnostically. Bar-like ONLY,
      // ALWAYS (even outside barLikeOnly): Rise's content wrapper is fixed/full-viewport — hiding it
      // would blank the lesson, the exact failure this guard prevents.
      for (const f of frameChain) {
        const fdoc = f.contentDocument;
        const fwin = f.contentWindow;
        if (!fdoc?.body || !fwin) continue;
        for (const el of Array.from(fdoc.body.querySelectorAll<HTMLElement>('*'))) {
          if (el === scroller || el.contains(scroller)) continue;
          const cs = fwin.getComputedStyle(el);
          if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
          if (cs.visibility === 'hidden' || cs.display === 'none') continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 1 || r.height <= 1) continue;
          if (!isBarLike(r, fwin)) continue; // protect the frame's content wrapper — only strip chrome bars
          hideEl(el, FIXED_ATTR);
          n++;
        }
      }
    } else {
      // Document-scroll mode: hide fixed + repeating-sticky (headers/chat/progress bars), keep in-flow content.
      for (const el of deepElements(document.body)) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const isFixed = cs.position === 'fixed';
        // Catch a sticky that repeats: stuck NOW, or DESIGNED to pin near an edge (isStuck misses the latter
        // because suppression runs at the top of the page, before it has stuck).
        const stickyRepeats = cs.position === 'sticky' && (isStuck(el, cs) || pinsNearEdge(cs, window));
        if (!isFixed && !stickyRepeats) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        // A repeating sticky is chrome ONLY when it's a bar (header/toolbar/progress strip); a tall sticky
        // (sidebar, content wrapper) must be kept — so gate sticky on bar-like ALWAYS, never blank content.
        if (stickyRepeats && !isBarLike(r, window)) continue;
        if (barLikeOnly && !isBarLike(r, window)) continue; // never hide a content block
        hideEl(hideTarget(el, null), FIXED_ATTR);
        n++;
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
    const declutterDoc = (root: ParentNode, win: Window): void => {
      for (const el of deepElements(root)) {
        if (scroller && (el === scroller || el.contains(scroller))) continue; // never hide the panel
        let match = false;
        try {
          match = el.matches(sel);
        } catch {
          match = false;
        }
        if (!match && !isChromeButton(el, win)) continue; // class/aria pattern OR generic chrome-text button
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) hideEl(hideTarget(el, scroller), DECLUTTER_ATTR);
      }
    };
    declutterDoc(document.body, window);
    // Also declutter inside every same-origin frame (course players put their nav/menu chrome in the frame).
    for (const { doc, win } of sameOriginFrameContexts()) if (doc.body) declutterDoc(doc.body, win);
  },

  // Enter "pick a section" mode: highlight the scroll pane under the cursor; on click, mark it as the
  // pane to capture and notify the service worker (or cancel on Esc / non-scrollable click). Installed
  // in the top document AND every reachable same-origin frame, so a pane inside a frame can be picked.
  startPick(): void {
    if (pickerCleanups.length) return; // already picking
    installPickerIn(document, window, false);
    for (const { doc, win } of sameOriginFrameContexts()) installPickerIn(doc, win, true);
    globalThis.__webclipCancelPick = stopAllPickers; // let the popup/worker cancel without a page click
  },

  clearPick(): void {
    clearPicked();
  },
  hasPick(): boolean {
    let found = false;
    forEachPickerDoc((doc) => {
      if (doc.querySelector(`[${PICKED_ATTR}]`)) found = true;
    });
    return found;
  },

  // Enter "mark a section" mode (WC-M11): highlight the content block under the cursor; on click, record
  // it for a one-shot region capture. Installed in the top document + every same-origin frame (so a Rise
  // accordion panel inside a SCORM frame can be marked).
  startMark(): void {
    // Fail-safe: always begin from a clean slate. A prior abort/exit that left an overlay behind used to
    // wedge mark mode (the old `if (markCleanups.length) return` early-returned into the stale state); now we
    // tear any leftover down first, so arming Mark always works without a manual arm/unmark.
    stopMark();
    markedBlock = null;
    installMarkIn(document, window, []);
    for (const { doc, win, chain } of sameOriginFrameContexts()) installMarkIn(doc, win, chain);
    globalThis.__webclipCancelPick = stopMark;
  },
  cancelMark(): void {
    stopMark();
  },

  // WC-M13 P2a: temporarily make the marked block's OWN scroller the active scroller, so the SW's shared
  // warmup (and, later, the shared capture engine) drives it via scrollContext/scrollPageTo — used to reveal
  // lazy content in a self-scrolling marked pane before measuring. Returns true only for a top-document,
  // self-scrolling marked block (framed / non-self-scroll marks keep their own path). Undo with
  // clearForcedScroller() before the normal region tiling.
  useMarkedBlockAsScroller(): boolean {
    if (!markedBlock || markedChain.length) return false; // top-document self-scroll only
    const { pane } = blockScroller();
    if (pane !== markedBlock) return false; // only when the block IS its own scroller
    scrollerEl = markedBlock;
    scrollerResolved = true;
    frameChain = [];
    originalScrollerTop = markedBlock.scrollTop;
    return true;
  },
  clearForcedScroller(): void {
    scrollerResolved = false; // next resolveScroller() re-resolves normally (blockScroller drives the tiling)
    scrollerEl = null;
    frameChain = [];
  },
  // Plan the capture of the marked block: its content size + how many viewport tiles it spans. Called
  // once after REGION_MARKED; the service worker then drives regionPositionTile() per tile.
  regionInfo(extraOverlapCss = 0): RegionInfo | null {
    if (!markedBlock) return null;
    const { pane, win, vpTopCss, vpHeightCss, scrollTop } = blockScroller();
    const brect = markedBlock.getBoundingClientRect();
    const widthCss = Math.max(1, Math.round(brect.width));
    // The block's LEFT in the top-document's viewport (frame chain + brect.left) — same convention as the
    // per-tile crop left. The base image shares this coordinate space, so it aligns the base column search.
    const blockContentLeftCss = Math.max(0, Math.round(frameOffset(markedChain).left + Math.max(0, brect.left)));
    // If the marked block IS its own scroller, its true content height is scrollHeight (the visible
    // clientHeight would capture only the fold), and its content starts at scroll offset 0.
    const selfScroll = pane === markedBlock;
    const heightCss = Math.max(1, Math.round(selfScroll ? markedBlock.scrollHeight : brect.height));
    // Content offset of the block's top within its scroller (so we can scroll each slice to the top).
    const blockContentTop = selfScroll ? 0 : scrollTop + (brect.top - vpTopCss);
    const tileHeightCss = Math.max(1, Math.min(heightCss, Math.floor(vpHeightCss)));
    // Overlap the tiles (only when the region is taller than one viewport) so the shared seam stitch has
    // content to pixel-match AND a frozen bar at the viewport edge lands in the overlap it strips — the same
    // reason full-page capture stays seam-clean. A single-tile mark keeps step = height (no overlap, no change).
    // `extraOverlapCss` (measured frozen-header height, from the worker) is ADDED so content that scrolls UNDER a
    // viewport-top-pinned header — e.g. GitHub's file bar over a whole-page mark — is carried on the prior tile
    // and not lost at each seam (mirrors captureFullPage's scroll-offset). Capped at half the tile. 0 = unchanged.
    const overlapCss = tileHeightCss >= heightCss ? 0 : Math.min(REGION_TILE_OVERLAP_CSS + Math.max(0, Math.round(extraOverlapCss)), Math.floor(tileHeightCss / 2));
    const tileStepCss = Math.max(1, tileHeightCss - overlapCss);
    const tileCount = overlapCss > 0 ? Math.max(1, Math.ceil((heightCss - overlapCss) / tileStepCss)) : Math.max(1, Math.ceil(heightCss / tileHeightCss));
    region = { widthCss, heightCss, tileHeightCss, tileStepCss, blockContentTop };
    void pane;
    void win;
    const hk = markedBlock ? markAnchorInfo(markedBlock) : { insideKeys: [], precedingKey: '' };
    // Is the marked block the DEFAULT (first) panel of a tab widget? Then a re-mark of the tab already in
    // the base must PATCH that region in place (the worker matches it to the base's recorded default extent).
    const tg = markedBlock ? markedTabGroup(markedBlock, window.innerWidth) : null;
    const isDefaultTab = !!tg && tg.group[0] === tg.panel;
    return { widthCss, heightCss, devicePixelRatio: window.devicePixelRatio || 1, fullViewportWidthCss: window.innerWidth, fullViewportHeightCss: window.innerHeight, tileCount, tileHeightCss, tileStepCss, anchorKeys: hk.insideKeys, precedingKey: hk.precedingKey, blockContentTopCss: blockContentTop, blockContentLeftCss, isDefaultTab };
  },

  // Scroll the marked block's scroller so slice `i` is at the top of its viewport; return the crop box
  // (in TOP-viewport CSS px, composited through any frame chain) and where the slice lands in the output.
  regionPositionTile(i: number): RegionTilePos | null {
    if (!markedBlock) return null;
    const { pane, win, vpHeightCss } = blockScroller();
    const target = region.blockContentTop + i * region.tileStepCss;
    if (pane) pane.scrollTop = target;
    else win.scrollTo({ left: 0, top: target, behavior: 'auto' });
    // The scroller CLAMPS to its max near the page bottom, so it can't always reach `target`. Read the
    // scroll it actually reached and place the slice by its ACTUAL content-Y — otherwise the last tiles
    // (captured at the clamped position) overlap and get stacked at the assumed Y, duplicating content
    // and clipping the true bottom (the "can't scroll past the end of the page" bug).
    const actualScroll = pane ? pane.scrollTop : win.scrollY;
    const off = frameOffset(markedChain);
    const brect = markedBlock.getBoundingClientRect(); // re-measured after the scroll
    const vpTop2 = pane ? pane.getBoundingClientRect().top : 0;
    const sliceTopInVp = Math.max(vpTop2, brect.top); // where the block starts within this viewport
    const vpBottom = vpTop2 + vpHeightCss;
    const destTopCss = Math.max(0, sliceTopInVp - vpTop2 + actualScroll - region.blockContentTop);
    const remaining = region.heightCss - destTopCss;
    const sliceH = Math.max(0, Math.min(remaining, vpBottom - sliceTopInVp));
    return {
      cropCss: {
        left: off.left + Math.max(0, brect.left),
        top: off.top + sliceTopInVp,
        width: region.widthCss,
        height: sliceH,
      },
      destTopCss,
    };
  },
  collectLinks(): PageLink[] {
    // Positions of meaningful <a href> targets in the captured panel's content coordinates (CSS px,
    // origin = panel top-left), so the renderer can lay clickable link annotations over the raster.
    // Call while the panel is at the top of its content (post-warmup). Virtualized feeds that unload
    // off-screen content will only yield the links currently in the DOM — best-effort.
    const out: PageLink[] = [];
    const hrefOf = (a: Element): string | null => {
      const raw = a.getAttribute('href') || '';
      if (raw.startsWith('#')) return null; // same-page anchor — no meaning in a standalone PDF
      const href = (a as HTMLAnchorElement).href; // resolved absolute URL
      return /^(https?|mailto|tel):/i.test(href) ? href : null; // skip javascript:, data:, blob:, etc.
    };
    const s = resolveScroller();
    const inner = activeFrame();
    // In-frame scroller (WC-M9 + nested): anchors' rects are relative to the INNERMOST frame's viewport;
    // map them to the scroller's content coordinates (origin = the scroller's content top-left), which
    // matches the crop box (the crop box already accounts for the frame's position in the top viewport).
    if (s && inner && inner.contentDocument && inner.contentWindow) {
      const doc = inner.contentDocument;
      const isFrameDoc = s === doc.scrollingElement;
      const box = isFrameDoc ? { left: 0, top: 0, width: inner.contentWindow.innerWidth } : s.getBoundingClientRect();
      const scrollTop = s.scrollTop;
      const scrollLeft = s.scrollLeft;
      const targets = deepLinkTargets(doc); // pierce shadow DOM; anchors + video/media embeds
      for (let i = 0; i < targets.length && out.length < 800; i++) {
        const href = targets[i].embed ?? hrefOf(targets[i].el);
        if (!href) continue;
        const r = targetRect(targets[i].el);
        if (r.width < 4 || r.height < 4) continue;
        const xCss = Math.max(0, r.left - box.left + scrollLeft);
        const yCss = r.top - box.top + scrollTop;
        if (yCss + r.height < 0) continue; // above the captured content
        out.push({ href, xCss, yCss, wCss: Math.min(r.width, box.width - xCss), hCss: r.height });
      }
      return out;
    }
    const ctx = this.scrollContext();
    const scrollTop = s ? s.scrollTop : window.scrollY;
    const targets = deepLinkTargets(document); // pierce shadow DOM; anchors + video/media embeds
    for (let i = 0; i < targets.length && out.length < 800; i++) {
      const href = targets[i].embed ?? hrefOf(targets[i].el);
      if (!href) continue;
      const r = targetRect(targets[i].el);
      if (r.width < 4 || r.height < 4) continue;
      if (r.right < ctx.rectLeft || r.left > ctx.rectLeft + ctx.rectWidth) continue; // outside the captured panel
      const xCss = Math.max(0, r.left - ctx.rectLeft);
      const yCss = r.top - ctx.rectTop + scrollTop;
      if (yCss + r.height < 0) continue; // above the captured content
      out.push({ href, xCss, yCss, wCss: Math.min(r.width, ctx.rectWidth - xCss), hCss: r.height });
    }
    return out;
  },

  // Scroll-offset support: the height (CSS px) of the chrome PINNED to the viewport top — a frozen header
  // (GitHub's file bar, a course "blue line") — so the tiler can overlap by it and not lose the content that
  // scrolls UNDER it. MECHANISM-AGNOSTIC: instead of trusting computed `position:fixed/sticky` (GitHub pins
  // its bar via JS, so that check found nothing), it measures what STAYS PUT across a scroll — record the
  // top bar-like elements at one scrolled position, scroll further, and keep those whose viewport rect didn't
  // move. Their max bottom is the frozen header height. Scrolls the document itself and restores. 0 if none.
  async measureTopFrozenCss(): Promise<number> {
    const se = (document.scrollingElement || document.documentElement) as HTMLElement;
    const vpH = window.innerHeight || 1;
    const vpW = window.innerWidth || 1;
    const y0 = se.scrollTop;
    const maxScroll = se.scrollHeight - vpH;
    if (maxScroll < vpH) return 0; // single screen → no seams
    const y1 = Math.min(Math.round(vpH), maxScroll);
    const y2 = Math.min(Math.round(vpH * 1.5), maxScroll);
    if (y2 - y1 < 40) return 0;
    const settle = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); // let scroll-driven pinning apply
    try {
      se.scrollTop = y1;
      await settle();
      const cand: Array<{ el: HTMLElement; top: number; bottom: number }> = [];
      for (const el of deepElements(document.body)) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 || r.height <= 1) continue;
        if (r.top > 0.35 * vpH || r.bottom <= 0) continue; // near the TOP
        if (r.height > 0.5 * vpH || (r.width * r.height) / (vpW * vpH) > 0.6) continue; // bar-like, not content/overlay
        cand.push({ el, top: r.top, bottom: r.bottom });
      }
      se.scrollTop = y2; // scroll further: content moves, a pinned bar does not
      await settle();
      let maxBottom = 0;
      for (const c of cand) {
        const r = c.el.getBoundingClientRect();
        if (Math.abs(r.top - c.top) < 3 && Math.abs(r.bottom - c.bottom) < 3 && r.top <= 0.35 * vpH && r.bottom > maxBottom) maxBottom = r.bottom;
      }
      return Math.round(Math.max(0, maxBottom));
    } finally {
      se.scrollTop = y0; // restore
    }
  },

  // G2: links inside the MARKED BLOCK, positioned relative to the block's own top-left in its content
  // coordinates (CSS px; includes the block's own scroll when it is its own scroller). This matches BOTH
  // region-capture paths — the region image's (0,0) is always the block's content top-left — so the
  // renderer can lay clickable annotations over the raster regardless of which tiling path composed it.
  // Best-effort like collectLinks (only links currently in the DOM). Top-document marks only; frame marks
  // (markedChain) return [] (their links stay non-clickable — a disclosed limitation, capture is unaffected).
  collectRegionLinks(): PageLink[] {
    if (!markedBlock || markedChain.length) return [];
    const { pane } = blockScroller();
    const selfScroll = pane === markedBlock;
    const brect = markedBlock.getBoundingClientRect();
    const blockScrollTop = selfScroll ? markedBlock.scrollTop : 0;
    const blockScrollLeft = selfScroll ? markedBlock.scrollLeft : 0;
    const widthCss = Math.max(1, brect.width);
    const heightCss = Math.max(1, selfScroll ? markedBlock.scrollHeight : brect.height);
    const hrefOf = (a: Element): string | null => {
      const raw = a.getAttribute('href') || '';
      if (raw.startsWith('#')) return null; // same-page anchor — meaningless in a standalone PDF
      const href = (a as HTMLAnchorElement).href; // resolved absolute URL
      return /^(https?|mailto|tel):/i.test(href) ? href : null; // skip javascript:, data:, blob:, etc.
    };
    const out: PageLink[] = [];
    const targets = deepLinkTargets(document); // pierce shadow DOM; anchors + video/media embeds
    for (let i = 0; i < targets.length && out.length < 800; i++) {
      const href = targets[i].embed ?? hrefOf(targets[i].el);
      if (!href) continue;
      const r = targetRect(targets[i].el);
      if (r.width < 4 || r.height < 4) continue;
      const xCss = r.left - brect.left + blockScrollLeft; // origin = block content top-left
      const yCss = r.top - brect.top + blockScrollTop;
      if (yCss + r.height < 0 || yCss > heightCss) continue; // outside the block vertically
      if (xCss + r.width < 0 || xCss > widthCss) continue; // outside horizontally
      const x = Math.max(0, xCss);
      out.push({ href, xCss: x, yCss, wCss: Math.min(r.width, widthCss - x), hCss: r.height });
    }
    return out;
  },

  // WC-M12: section-header anchors in the captured content's coordinates (CSS px from content top), so a
  // marked/snapped piece can splice in at the matching header. Same coordinate mapping as collectLinks.
  collectAnchors(): Anchor[] {
    const out: Anchor[] = [];
    const seen = new Set<string>();
    const push = (key: string, yCss: number, hCss: number): void => {
      if (!key || seen.has(key) || yCss < -2) return;
      seen.add(key);
      out.push({ key, yCss, hCss }); // yCss = header TOP → a mark overwrites the collapsed header (hCss rows)
    };
    const s = resolveScroller();
    const inner = activeFrame();
    if (s && inner && inner.contentDocument && inner.contentWindow) {
      const doc = inner.contentDocument;
      const isFrameDoc = s === doc.scrollingElement;
      const box = isFrameDoc ? { top: 0 } : s.getBoundingClientRect();
      const scrollTop = s.scrollTop;
      const els = doc.querySelectorAll(ANCHOR_SEL);
      for (let i = 0; i < els.length && out.length < 600; i++) {
        const r = els[i].getBoundingClientRect();
        if (r.height < 4) continue;
        push(anchorKeyOf(els[i]), r.top - box.top + scrollTop, r.height);
      }
      return out;
    }
    const ctx = this.scrollContext();
    const scrollTop = s ? s.scrollTop : window.scrollY;
    const els = document.querySelectorAll(ANCHOR_SEL);
    for (let i = 0; i < els.length && out.length < 600; i++) {
      const r = els[i].getBoundingClientRect();
      if (r.height < 4) continue;
      push(anchorKeyOf(els[i]), r.top - ctx.rectTop + scrollTop, r.height);
    }
    return out;
  },
  // WC-M12: extents (content-Y) of every tab widget's DEFAULT (currently-visible) panel, measured while
  // the base is being captured — so the worker knows exactly where the default view ends and can inject
  // the other tabs' marks right after it (and PATCH a re-marked default in place). Same coordinate mapping
  // as collectAnchors/collectLinks.
  collectTabPanels(): import('../shared/types.js').TabPanelExtent[] {
    const out: import('../shared/types.js').TabPanelExtent[] = [];
    const recorded = new Set<Element>();
    const vpW = window.innerWidth;
    const scan = (doc: Document, mapTop: (top: number) => number): void => {
      // Hidden panels reveal a tab group; their one visible alike sibling is the default view in the base.
      const cands = doc.querySelectorAll<HTMLElement>('[role="tabpanel"], [hidden], [aria-hidden="true"], .tab-pane, [data-tab], [class*="tabpanel" i], [class*="tab-pane" i]');
      for (let i = 0; i < cands.length && out.length < 200; i++) {
        const h = cands[i];
        if (!(h instanceof HTMLElement) || !elHidden(h)) continue;
        const g = tabPanelGroupAround(h, vpW);
        if (!g) continue;
        const def = g.find((c) => elVisibleBlock(c, vpW));
        if (!def || recorded.has(def)) continue;
        recorded.add(def);
        const r = def.getBoundingClientRect();
        const top = mapTop(r.top);
        out.push({ topCss: top, bottomCss: top + r.height });
      }
    };
    const s = resolveScroller();
    const inner = activeFrame();
    if (s && inner && inner.contentDocument && inner.contentWindow) {
      const doc = inner.contentDocument;
      const isFrameDoc = s === doc.scrollingElement;
      const box = isFrameDoc ? { top: 0 } : s.getBoundingClientRect();
      const scrollTop = s.scrollTop;
      scan(doc, (top) => top - box.top + scrollTop);
      return out;
    }
    const ctx = this.scrollContext();
    const scrollTop = s ? s.scrollTop : window.scrollY;
    scan(document, (top) => top - ctx.rectTop + scrollTop);
    return out;
  },
  // The fixed HEADER / FOOTER bands of an open modal (top-viewport CSS px) — the strips ABOVE and BELOW its
  // inner scroll pane (title/progress bar; action buttons). The capture crops these from a tile and stacks
  // them around the tiled body so the modal reads whole. Null when there is no modal, or the modal has no
  // separate inner pane (then the whole modal is the scroller and nothing extra needs adding).
  modalBands(): import('../shared/types.js').ModalBands | null {
    const modal = findOpenModal();
    if (!modal) return null;
    const pane = largestScrollPanelIn(modal);
    if (!pane) return null;
    const m = modal.getBoundingClientRect();
    const p = pane.getBoundingClientRect();
    const vpW = window.innerWidth;
    const band = (top: number, height: number): { left: number; top: number; width: number; height: number } | null => {
      if (height <= 2) return null;
      const left = Math.max(0, m.left);
      const right = Math.min(vpW, m.right);
      return { left, top: Math.max(0, top), width: Math.max(1, right - left), height };
    };
    return { header: band(m.top, p.top - m.top), footer: band(p.bottom, m.bottom - p.bottom) };
  },
  restore(): void {
    document.getElementById(STYLE_ID)?.remove();
    for (const f of frameChain) if (f.contentDocument) f.contentDocument.getElementById(STYLE_ID)?.remove();
    restoreHidden();
    restoreExpanded();
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
    // Reset scroller/frame caches so the next capture re-resolves against the restored page.
    scrollerResolved = false;
    scrollerEl = null;
    frameChain = [];
  },
};

globalThis.__webclipController = controller;
