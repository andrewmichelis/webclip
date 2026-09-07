// Settings persistence. Small preferences only, in chrome.storage.sync (never large binaries §10).
import { DEFAULT_SETTINGS } from './types.js';
import type { UserSettings, PaperSize, Orientation, ImageFormat, CaptureMode } from './types.js';

const KEY = 'settings';

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * Coerce an untrusted settings object to a valid UserSettings — every field validated/clamped against
 * DEFAULT_SETTINGS. Defense in depth for the START_CAPTURE message path (security T-2): the message
 * sender is always the extension's own context, but a malformed payload must never reach the renderer.
 */
export function coerceSettings(raw: unknown): UserSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof UserSettings, unknown>>;
  const d = DEFAULT_SETTINGS;
  const q = typeof s.jpegQuality === 'number' && Number.isFinite(s.jpegQuality) ? s.jpegQuality : d.jpegQuality;
  return {
    captureMode: oneOf<CaptureMode>(s.captureMode, ['full-page', 'visible'], d.captureMode),
    paperSize: oneOf<PaperSize>(s.paperSize, ['A4', 'LETTER', 'AUTO'], d.paperSize),
    orientation: oneOf<Orientation>(s.orientation, ['auto', 'portrait', 'landscape'], d.orientation),
    imageFormat: oneOf<ImageFormat>(s.imageFormat, ['png', 'jpeg'], d.imageFormat),
    jpegQuality: Math.min(1, Math.max(0.1, q)),
    evidenceMode: bool(s.evidenceMode, d.evidenceMode),
    saveChecksum: bool(s.saveChecksum, d.saveChecksum),
    warmupLazyContent: bool(s.warmupLazyContent, d.warmupLazyContent),
    suppressAnimations: bool(s.suppressAnimations, d.suppressAnimations),
    suppressRepeatedFixedElements: bool(s.suppressRepeatedFixedElements, d.suppressRepeatedFixedElements),
    declutter: bool(s.declutter, d.declutter),
    stamp: bool(s.stamp, d.stamp),
    links: bool(s.links, d.links),
    debugTiles: bool(s.debugTiles, d.debugTiles),
    filenameTemplate: typeof s.filenameTemplate === 'string' && s.filenameTemplate.length <= 200 ? s.filenameTemplate : d.filenameTemplate,
  };
}

export async function loadSettings(): Promise<UserSettings> {
  const got = await chrome.storage.sync.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((got[KEY] as Partial<UserSettings> | undefined) ?? {}) };
}

export async function saveSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const next: UserSettings = { ...(await loadSettings()), ...patch };
  await chrome.storage.sync.set({ [KEY]: next });
  return next;
}
