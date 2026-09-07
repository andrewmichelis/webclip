// Typed runtime message contract between popup/options and the service worker.
// Every inbound message is validated by type + shape before handling (security §39, ARCH-WC-04).

import type { UserSettings, ActiveTabInfo, CaptureProgress, PaperSize, Orientation } from './types.js';
import type { CaptureError } from './errors.js';

export type ExtensionMessage =
  | { type: 'PING' }
  | { type: 'GET_ACTIVE_TAB' }
  | { type: 'START_CAPTURE'; settings: UserSettings }
  | { type: 'CANCEL_CAPTURE'; jobId: string }
  | { type: 'START_PICK' } // popup -> SW: begin "pick a section" mode
  | { type: 'STOP_PICK' } // popup -> SW: cancel pick mode (no page click needed)
  | { type: 'PANE_PICKED' } // picker -> SW: user selected a pane (marks it; does NOT capture)
  | { type: 'PICK_CANCELLED' } // picker -> SW: user cancelled
  | { type: 'CLEAR_PICK' } // popup -> SW: clear the selected section
  | { type: 'HAS_PICK' } // popup -> SW: is a section currently selected?
  | { type: 'SNAPSHOT_START'; paperSize?: PaperSize; orientation?: Orientation } // popup -> SW: begin manual snapshot & stitch mode (WC-M10); carries the popup's per-capture paper/layout (G1)
  | { type: 'SNAPSHOT_START_ATLAS'; paperSize?: PaperSize; orientation?: Orientation } // popup -> SW: begin composite capture — full-page base + mark/snap (WC-M12); carries the popup's per-capture paper/layout (G1)
  | { type: 'SNAPSHOT_ADD' } // toolbar -> SW: capture the current view as a snapshot
  | { type: 'SNAPSHOT_MARK' } // toolbar -> SW: arm "mark a section" mode (WC-M11)
  | { type: 'REGION_MARKED' } // page -> SW: a section was marked; capture it as a region
  | { type: 'MARK_CANCELLED' } // page -> SW: mark mode cancelled (Esc)
  | { type: 'SNAPSHOT_MARK_CANCEL' } // toolbar -> SW: cancel the armed mark mode (the Mark button toggled to Cancel)
  | { type: 'SNAPSHOT_UNDO' } // toolbar -> SW: drop the last captured piece
  | { type: 'SNAPSHOT_FINISH' } // toolbar -> SW: assemble all snapshots into one PDF
  | { type: 'SNAPSHOT_CANCEL' }; // toolbar -> SW: discard the snapshot session

export type MessageType = ExtensionMessage['type'];

const MESSAGE_TYPES: readonly MessageType[] = [
  'PING',
  'GET_ACTIVE_TAB',
  'START_CAPTURE',
  'CANCEL_CAPTURE',
  'START_PICK',
  'STOP_PICK',
  'PANE_PICKED',
  'PICK_CANCELLED',
  'CLEAR_PICK',
  'HAS_PICK',
  'SNAPSHOT_START',
  'SNAPSHOT_START_ATLAS',
  'SNAPSHOT_ADD',
  'SNAPSHOT_MARK',
  'REGION_MARKED',
  'MARK_CANCELLED',
  'SNAPSHOT_MARK_CANCEL',
  'SNAPSHOT_UNDO',
  'SNAPSHOT_FINISH',
  'SNAPSHOT_CANCEL',
];

// --- Response shapes ---
export interface PingResult {
  ok: true;
  product: string;
  version: string;
}

export type ActiveTabResult =
  | { ok: true; tab: ActiveTabInfo }
  | { ok: false; error: CaptureError };

export type StartCaptureResult =
  | { ok: true; filename: string; warning?: string; pages?: number }
  | { ok: false; error: CaptureError };

/** Broadcast from the service worker to the popup during a long capture (not sent TO the worker). */
export interface JobProgressMessage {
  type: 'JOB_PROGRESS';
  payload: CaptureProgress;
}

/** Narrowing runtime guard: is this an object with a known `type`? */
export function isExtensionMessage(x: unknown): x is ExtensionMessage {
  if (typeof x !== 'object' || x === null) return false;
  const t = (x as { type?: unknown }).type;
  if (typeof t !== 'string' || !MESSAGE_TYPES.includes(t as MessageType)) return false;
  switch (t as MessageType) {
    case 'START_CAPTURE':
      return typeof (x as { settings?: unknown }).settings === 'object' && (x as { settings?: unknown }).settings !== null;
    case 'CANCEL_CAPTURE':
      return typeof (x as { jobId?: unknown }).jobId === 'string';
    default:
      return true;
  }
}
