// Output artifacts: the PDF plus optional Evidence Mode sidecars.
// SHA-256 is detached (never embedded in the PDF it hashes). The JSON manifest records
// source + capture metadata and is explicit that the local clock is not a trusted timestamp.
import { downloadPdf, downloadText } from './downloads.js';
import { PRODUCT_NAME, VERSION } from '../shared/constants.js';
import type { UserSettings, CaptureMode } from '../shared/types.js';

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface EvidenceSource {
  url: string;
  title: string;
  domain: string;
}

export interface EvidenceStamp {
  capturedAtUtc: string;
  timezone: string;
  captureId: string;
}

/**
 * Save the PDF and, if enabled, a `.sha256` checksum sidecar and/or a JSON evidence manifest.
 * Deterministic download order: PDF, then checksum, then manifest.
 */
export async function saveArtifacts(
  pdfBytes: Uint8Array,
  filename: string,
  source: EvidenceSource,
  mode: CaptureMode,
  settings: UserSettings,
  stamp: EvidenceStamp,
): Promise<void> {
  await downloadPdf(pdfBytes, filename, false);
  if (!settings.evidenceMode && !settings.saveChecksum) return;

  const hex = await sha256Hex(pdfBytes);
  if (settings.saveChecksum) {
    // octet-stream so Chrome keeps the .sha256 extension (text/plain gets coerced to .txt).
    await downloadText(`${hex}  ${filename}\n`, `${filename}.sha256`, 'application/octet-stream');
  }
  if (settings.evidenceMode) {
    const manifest = {
      schema: 'page-capture-evidence/1.0',
      captureId: stamp.captureId,
      source,
      capture: { mode, capturedAtUtc: stamp.capturedAtUtc, timezone: stamp.timezone },
      software: { name: PRODUCT_NAME, version: VERSION, manifestVersion: 3 },
      artifacts: [{ name: filename, mediaType: 'application/pdf', sha256: hex }],
      trust: { timestampType: 'local-system-clock', trustedTimestamp: false },
    };
    await downloadText(`${JSON.stringify(manifest, null, 2)}\n`, filename.replace(/\.pdf$/, '.json'), 'application/json');
  }
}
