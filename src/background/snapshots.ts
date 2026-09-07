// Manual snapshot & stitch session store (WC-M10). Each user "Snapshot" records the screenshot bytes
// plus the content scroll offset + panel rect, kept in IndexedDB so the session survives MV3 service-
// worker suspension between the user's clicks. One session at a time; cleared on finish/cancel.

const DB_NAME = 'webclip-snapshots';
const STORE = 'snaps';

export interface SnapshotRecord {
  seq: number; // capture order (top -> bottom as the user scrolls / marks)
  bytes: ArrayBuffer; // the image (png/jpeg): a viewport screenshot, OR a composed region (kind 'region')
  scrollTop: number; // the active scroller's scrollTop at capture (drives overlap dedupe)
  viewportWidthCss: number;
  viewportHeightCss: number;
  rect: { top: number; left: number; width: number; height: number }; // panel/frame box to keep per shot
  clientHeight: number; // the scroller's own viewport height (effective tile height)
  links: import('../shared/types.js').PageLink[]; // links visible in this shot (content-absolute coords)
  kind?: 'viewport' | 'region' | 'base'; // Snap (M10) · marked region (M11) · full-page base atlas (M12)
  regionWidthPx?: number; // region/base: composed image width in device px
  regionHeightPx?: number; // region/base: composed image height in device px
  anchors?: import('../shared/types.js').Anchor[]; // base only (M12): header anchors {key, yCss}
  tabPanels?: import('../shared/types.js').TabPanelExtent[]; // base only (M12): default tab-panel extents (content-Y) for exact tab splicing
  scaleY?: number; // base only (M12): css→device px, to map an anchor yCss into base image px
  contentLeftCss?: number; // base only: the base image's LEFT in viewport content coords — the base is cropped to
  // the content column (left>0 on indented/framed pages), so the pixel-relocate must subtract it from a mark's
  // regionContentLeftCss to search the right column (else the search x is shifted right and mis-matches).
  anchorKeys?: string[]; // region only (M12): header keys inside the mark (DOM order) — locate + bound the splice
  precedingKey?: string; // region only (M12): header just before the mark, when the mark has none of its own
  regionContentTopCss?: number; // region only (M12): the mark's TOP in content coords — place by AREA if no header match
  regionContentLeftCss?: number; // region only: the mark's LEFT in content coords — aligns the pixel-relocate column search in the base
  isDefaultTab?: boolean; // region only (M12): the mark is a tab widget's DEFAULT panel — PATCH that base region in place
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'seq' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | null, result: () => T): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        run(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(result());
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

export async function addSnapshot(rec: SnapshotRecord): Promise<void> {
  await tx('readwrite', (s) => s.put(rec), () => undefined);
}

export async function getSnapshots(): Promise<SnapshotRecord[]> {
  const db = await openDb();
  const all = await new Promise<SnapshotRecord[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as SnapshotRecord[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return all.sort((a, b) => a.seq - b.seq);
}

export async function snapshotCount(): Promise<number> {
  const db = await openDb();
  const n = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return n;
}

export async function clearSnapshots(): Promise<void> {
  await tx('readwrite', (s) => s.clear(), () => undefined);
}

/** Drop the most recent snapshot (Undo). Returns the remaining count. */
export async function deleteLastSnapshot(): Promise<number> {
  const all = await getSnapshots();
  if (!all.length) return 0;
  const last = all[all.length - 1];
  await tx('readwrite', (s) => s.delete(last.seq), () => undefined);
  return all.length - 1;
}
