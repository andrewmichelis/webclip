// Ambient globals.

// Build-time constant injected by esbuild `define` (scripts/build.mjs) from package.json.
declare const __VERSION__: string;

// Set by the "pick a section" picker so it can be cancelled externally (popup/worker) without a click.
declare var __webclipCancelPick: (() => void) | undefined;

// The page controller singleton installed by content/page-controller.ts into the
// active tab's isolated world; driven from the service worker via executeScript.
declare var __webclipController:
  | {
      prepare(opts: import('./types.js').PrepareOptions): void;
      measure(): import('./types.js').PageMetrics;
      scrollContext(): import('./types.js').ScrollContext;
      scrollTo(x: number, y: number): { scrollX: number; scrollY: number };
      setFixedHidden(hidden: boolean): number;
      declutter(on: boolean): void;
      startPick(): void;
      clearPick(): void;
      hasPick(): boolean;
      collectLinks(): import('./types.js').PageLink[];
      restore(): void;
    }
  | undefined;
