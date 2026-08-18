// Download helper. MV3 service workers have no URL.createObjectURL, so we hand
// chrome.downloads a base64 data: URL (fine for single-page captures; an offscreen
// document for large multi-page output is a later consideration).

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function bytesToDataUri(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Save PDF bytes via chrome.downloads. Returns the download id. */
export async function downloadPdf(bytes: Uint8Array, filename: string, saveAs = false): Promise<number> {
  const url = bytesToDataUri(bytes, 'application/pdf');
  return chrome.downloads.download({ url, filename, saveAs });
}

/** Save a small text sidecar (JSON manifest, .sha256) next to the PDF. */
export async function downloadText(text: string, filename: string, mime: string): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  const url = `data:${mime};charset=utf-8;base64,${bytesToBase64(bytes)}`;
  return chrome.downloads.download({ url, filename, saveAs: false });
}
