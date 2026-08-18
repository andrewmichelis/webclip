import { describe, it, expect } from 'vitest';
import { buildVerticalPositions, computeScreenshotScale } from '../../src/shared/capture-plan.js';

describe('buildVerticalPositions', () => {
  it('returns a single position when the page fits the viewport', () => {
    expect(buildVerticalPositions(600, 1000, 32)).toEqual([0]);
    expect(buildVerticalPositions(1000, 1000, 32)).toEqual([0]);
  });

  it('tiles an exact multiple with no overlap', () => {
    expect(buildVerticalPositions(3000, 1000, 0)).toEqual([0, 1000, 2000]);
  });

  it('applies overlap and always clamps the last tile to the bottom', () => {
    const pos = buildVerticalPositions(2500, 1000, 100); // step 900, last 1500
    expect(pos[0]).toBe(0);
    expect(pos[pos.length - 1]).toBe(1500); // bottom exactly covered
    expect(pos).toEqual([0, 900, 1500]);
  });

  it('does not duplicate the final position', () => {
    const pos = buildVerticalPositions(2000, 1000, 0); // last === 1000, loop stops before it
    expect(pos).toEqual([0, 1000]);
    expect(new Set(pos).size).toBe(pos.length);
  });
});

describe('computeScreenshotScale', () => {
  it('derives scale from measured image vs viewport', () => {
    expect(computeScreenshotScale(2000, 1500, 1000, 750)).toEqual({ scaleX: 2, scaleY: 2 });
  });
  it('guards against zero viewport', () => {
    expect(computeScreenshotScale(1000, 1000, 0, 0)).toEqual({ scaleX: 1, scaleY: 1 });
  });
});
