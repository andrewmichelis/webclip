// Centralized product identity + tuning constants (ARCH-WC-13: name/version in one place).

/** Display name of the product. Do not hard-code "WebClip" elsewhere; import this. */
export const PRODUCT_NAME = 'WebClip';

/** Version, injected at build from package.json (single source of truth). */
export const VERSION: string = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';

/**
 * Chrome documents a maximum of 2 `captureVisibleTab` calls per second (ARCH-WC-08).
 * We schedule conservatively above that floor. Used from M2/M4 onward.
 */
export const MIN_CAPTURE_INTERVAL_MS = 600;

/** Default overlap between vertical tiles, in CSS px (used from M4). */
export const DEFAULT_TILE_OVERLAP_CSS = 48;

/** URL schemes on which a page cannot be scripted, so only visible-area capture may work (see §55). */
export const RESTRICTED_SCHEMES = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'devtools:', 'view-source:'];
