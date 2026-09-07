import { describe, it, expect } from 'vitest';
import { isFrameContentUncaptured } from '../../src/shared/frames.js';
import type { FrameRect } from '../../src/shared/frames.js';

/** Build an iframe rect from a top-left origin + size (CSS px). */
function frame(left: number, top: number, width: number, height: number): FrameRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe('isFrameContentUncaptured', () => {
  it('flags a SCORM/LMS page: non-scrolling top doc dominated by a full-viewport frame', () => {
    // The reported Wind River case: docHeight === viewport, one same-origin frame at 93% cover.
    expect(
      isFrameContentUncaptured({
        docHeight: 1221,
        viewportWidth: 1280,
        viewportHeight: 1221,
        frameRects: [frame(0, 0, 644, 1131)],
      }),
    ).toBe(true);
  });

  it('does NOT flag an ordinary long page that scrolls, even with a big embedded frame', () => {
    expect(
      isFrameContentUncaptured({
        docHeight: 8000, // page itself scrolls → full-page capture already covers it
        viewportWidth: 1280,
        viewportHeight: 900,
        frameRects: [frame(0, 0, 1280, 800)],
      }),
    ).toBe(false);
  });

  it('does NOT flag a short page that merely embeds a video (frame too short)', () => {
    expect(
      isFrameContentUncaptured({
        docHeight: 900,
        viewportWidth: 1280,
        viewportHeight: 900,
        frameRects: [frame(300, 200, 640, 360)], // 16:9 video, well under the height threshold
      }),
    ).toBe(false);
  });

  it('does NOT flag when there are no frames', () => {
    expect(
      isFrameContentUncaptured({ docHeight: 900, viewportWidth: 1280, viewportHeight: 900, frameRects: [] }),
    ).toBe(false);
  });

  it('ignores zero-size (hidden/tracking) frames', () => {
    expect(
      isFrameContentUncaptured({
        docHeight: 950,
        viewportWidth: 1280,
        viewportHeight: 900,
        frameRects: [frame(0, 0, 0, 0), frame(-10, -10, 1, 1)],
      }),
    ).toBe(false);
  });

  it('requires BOTH area and height dominance (a tall but narrow sidebar frame is not the main content)', () => {
    expect(
      isFrameContentUncaptured({
        docHeight: 900,
        viewportWidth: 1280,
        viewportHeight: 900,
        frameRects: [frame(0, 0, 300, 900)], // full height, but only ~23% of the viewport area
      }),
    ).toBe(false);
  });

  it('counts only the on-screen overlap: a frame scrolled mostly out of view does not dominate', () => {
    expect(
      isFrameContentUncaptured({
        docHeight: 950,
        viewportWidth: 1280,
        viewportHeight: 900,
        frameRects: [frame(0, 800, 1280, 1200)], // 1200 tall but only 100px visible in the viewport
      }),
    ).toBe(false);
  });

  it('guards against a degenerate zero viewport', () => {
    expect(
      isFrameContentUncaptured({ docHeight: 0, viewportWidth: 0, viewportHeight: 0, frameRects: [frame(0, 0, 100, 100)] }),
    ).toBe(false);
  });
});
