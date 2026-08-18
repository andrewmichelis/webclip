// Stable error codes. Production UI shows `message`, never raw stack traces.

export type CaptureErrorCode =
  | 'NO_ACTIVE_TAB'
  | 'UNSUPPORTED_PAGE'
  | 'SCRIPT_INJECTION_FAILED'
  | 'ACTIVE_TAB_CHANGED'
  | 'PAGE_NAVIGATED'
  | 'CAPTURE_RATE_LIMIT'
  | 'SCREENSHOT_FAILED'
  | 'PAGE_TOO_LARGE'
  | 'OUT_OF_MEMORY'
  | 'PDF_RENDER_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'CANCELLED'
  | 'RESTORE_FAILED'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';

export interface CaptureError {
  code: CaptureErrorCode;
  /** User-readable message. */
  message: string;
  /** Optional detail for logs/diagnostics; never shown raw in production UI. */
  technicalMessage?: string;
  recoverable: boolean;
  jobId?: string;
}

export function makeError(
  code: CaptureErrorCode,
  message: string,
  opts: { recoverable?: boolean; technicalMessage?: string; jobId?: string } = {},
): CaptureError {
  return {
    code,
    message,
    recoverable: opts.recoverable ?? false,
    ...(opts.technicalMessage !== undefined ? { technicalMessage: opts.technicalMessage } : {}),
    ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
  };
}
