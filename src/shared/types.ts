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

/** A candidate injection point in the base atlas (WC-M12): a section header's normalized text + its
 *  content-Y (CSS px from the captured content top). A marked/snapped piece with a matching key splices
 *  in at this Y; no match / ambiguous → the piece is dropped (never guess). */
export interface Anchor {
  key: string;
  yCss: number; // header TOP in content CSS px
  hCss: number; // header height — the base rows a mark overwrites (so its header isn't duplicated)
}

/** The fixed HEADER / FOOTER bands of an open modal (top-viewport CSS px) — the parts ABOVE and BELOW its
 *  inner scroll pane. Captured once each and stacked around the tiled body so the modal reads whole. */
export interface ModalBands {
  header: { left: number; top: number; width: number; height: number } | null;
  footer: { left: number; top: number; width: number; height: number } | null;
}

/** A tab-widget's DEFAULT (base-visible) panel extent in content coords (WC-M12). Recorded during the
 *  base capture, when the default tab is the one showing. Marks of the OTHER tabs of the same widget
 *  splice right after `bottomCss` (append after the default view); a re-mark of the default tab REPLACES
 *  [topCss, bottomCss] (patch in place, no duplicate). */
export interface TabPanelExtent {
  topCss: number; // the default panel's TOP in content CSS px (same space as Anchor.yCss)
  bottomCss: number; // the default panel's BOTTOM — where the following tabs' marks are injected
}

/** Plan for capturing one MARKED region (WC-M11): its content size + how many viewport tiles it spans. */
export interface RegionInfo {
  widthCss: number;
  heightCss: number;
  devicePixelRatio: number;
  fullViewportWidthCss: number; // top window innerWidth — used to MEASURE the true screenshot scale
  fullViewportHeightCss: number; // top window innerHeight — the shared stitch measures scaleY from this
  tileCount: number;
  tileHeightCss: number;
  tileStepCss: number; // content-Y advance per tile = tileHeightCss - overlap (>1 tile) so the seam matcher has overlap
  anchorKeys: string[]; // WC-M12: header keys INSIDE the mark (DOM order) — locate + bound its splice
  precedingKey: string; // if the mark has no header of its own, the section header just before it
  blockContentTopCss: number; // the marked block's TOP in the content's coordinates (same space as the
  // base anchors' yCss) — used to place the mark by the AREA it was captured at when no header matches
  blockContentLeftCss: number; // the marked block's LEFT in the top-document's coordinates (frame chain +
  // brect.left) — aligns the pixel-relocate column search so an indented widget matches in the base
  isDefaultTab?: boolean; // WC-M12: the marked block is the DEFAULT (first) panel of a tab widget — a
  // re-mark of the tab already shown in the base, so it PATCHES that region in place instead of appending
}
/** Per-tile placement for a marked region: the crop box in the TOP viewport (CSS px) and where that
 *  slice lands in the composed region image (CSS px from the region top). */
export interface RegionTilePos {
  cropCss: { left: number; top: number; width: number; height: number };
  destTopCss: number;
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

/** Page geometry measured by the injected controller (handover §17). */
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
  /** Force collapsible sections open before capture (reversible on restore). */
  expandCollapsible: boolean;
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
  /** Set when the resolved scroller is the top document but a large CROSS-ORIGIN <iframe> dominates the
   *  viewport, so the capture cannot reach the frame's inner content (browser same-origin policy). The
   *  orchestrator surfaces an honest warning. Same-origin frames are descended into and captured (WC-M9),
   *  so this flag is only ever set for cross-origin / otherwise-unreachable frames. */
  frameContentUncaptured?: boolean;
}

/** Progress emitted by the full-page orchestrator to the popup (handover §42). */
export interface CaptureProgress {
  phase: 'preparing' | 'capturing' | 'rendering' | 'downloading' | 'restoring';
  completed: number;
  total: number;
  percent: number;
}
