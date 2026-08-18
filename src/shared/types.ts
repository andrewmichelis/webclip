// Core data types shared across the extension. The M1 shell uses the tab/capability
// types; capture/settings types are the forward contract implemented from M2 onward.

export type CaptureMode = 'full-page' | 'visible';
export type PaperSize = 'A4' | 'LETTER' | 'AUTO';
export type Orientation = 'auto' | 'portrait' | 'landscape';
export type ImageFormat = 'png' | 'jpeg';

/** User-configurable preferences (persisted via chrome.storage). Subset is wired in M1. */
export interface UserSettings {
  captureMode: CaptureMode;
  paperSize: PaperSize;
  orientation: Orientation;
  imageFormat: ImageFormat;
  jpegQuality: number;
  evidenceMode: boolean;
  saveChecksum: boolean;
  warmupLazyContent: boolean;
  suppressAnimations: boolean;
  suppressRepeatedFixedElements: boolean;
  declutter: boolean;
  /** Stamp a header (title) on the first page and a footer (URL · capture time · page) on every page. */
  stamp: boolean;
  /** Carry meaningful page links (http/mailto/tel) into the PDF as clickable link annotations. */
  links: boolean;
  /** Troubleshooting: also save the raw capture tiles + crop metadata alongside the PDF. */
  debugTiles: boolean;
  filenameTemplate: string;
}

/** A hyperlink to carry into the PDF, positioned in the captured panel's content (CSS px, top-left origin). */
export interface PageLink {
  href: string;
  xCss: number;
  yCss: number;
  wCss: number;
  hCss: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  captureMode: 'full-page',
  paperSize: 'AUTO', // one continuous page (screen-friendly) by default; pick A4/Letter to make it printable
  orientation: 'auto',
  imageFormat: 'png',
  jpegQuality: 0.92,
  evidenceMode: false,
  saveChecksum: false,
  warmupLazyContent: true,
  suppressAnimations: true,
  suppressRepeatedFixedElements: true,
  declutter: true,
  stamp: false,
  links: true,
  debugTiles: false,
  filenameTemplate: '{domain}_{title}_{date}_{time}',
};

/** What the active page supports. Full-page needs script injection; some surfaces allow neither. */
export interface CaptureCapability {
  visible: boolean;
  fullPage: boolean;
  /** Human-readable reason when a mode is unavailable. */
  reason?: string;
}

/** Resolved active-tab context (produced by the service worker in M1). */
export interface ActiveTabInfo {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  domain: string;
  capability: CaptureCapability;
}

/** Page geometry measured by the injected controller. */
export interface PageMetrics {
  viewportWidthCss: number;
  viewportHeightCss: number;
  documentWidthCss: number;
  documentHeightCss: number;
  initialScrollX: number;
  initialScrollY: number;
  devicePixelRatio: number;
}

/** How the injected controller should prepare a page before a full-page capture. */
export interface PrepareOptions {
  suppressAnimations: boolean;
  suppressRepeatedFixedElements: boolean;
  declutter: boolean;
}

/**
 * The active scroll context: either the document/window or the dominant inner scroll panel
 * (LinkedIn, Gmail, docs, dashboards scroll a child element, not the page). `rect*` is the
 * panel's box in the browser viewport, used to crop each screenshot to just that panel.
 */
export interface ScrollContext {
  scrollHeight: number; // total scrollable content height (CSS px)
  clientHeight: number; // the scroller's own viewport height (CSS px)
  scrollTop: number;
  rectTop: number; // scroller box top within the browser viewport (CSS px)
  rectLeft: number;
  rectWidth: number;
  rectHeight: number; // visible height of the scroller box in the viewport (CSS px)
  fullViewportWidth: number; // window.innerWidth
  fullViewportHeight: number; // window.innerHeight
  isWindow: boolean;
}

/** Progress emitted by the full-page orchestrator to the popup. */
export interface CaptureProgress {
  phase: 'preparing' | 'capturing' | 'rendering' | 'downloading' | 'restoring';
  completed: number;
  total: number;
  percent: number;
}
