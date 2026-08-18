import { describe, it, expect } from 'vitest';
import { isExtensionMessage } from '../../src/shared/messages.js';
import { DEFAULT_SETTINGS } from '../../src/shared/types.js';

describe('isExtensionMessage', () => {
  it('accepts well-formed messages', () => {
    expect(isExtensionMessage({ type: 'PING' })).toBe(true);
    expect(isExtensionMessage({ type: 'GET_ACTIVE_TAB' })).toBe(true);
    expect(isExtensionMessage({ type: 'START_CAPTURE', settings: DEFAULT_SETTINGS })).toBe(true);
    expect(isExtensionMessage({ type: 'CANCEL_CAPTURE', jobId: 'abc' })).toBe(true);
  });

  it('rejects unknown or malformed messages', () => {
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage(undefined)).toBe(false);
    expect(isExtensionMessage('PING')).toBe(false);
    expect(isExtensionMessage({})).toBe(false);
    expect(isExtensionMessage({ type: 'NOPE' })).toBe(false);
    expect(isExtensionMessage({ type: 'START_CAPTURE' })).toBe(false); // missing settings
    expect(isExtensionMessage({ type: 'CANCEL_CAPTURE' })).toBe(false); // missing jobId
    expect(isExtensionMessage({ type: 'CANCEL_CAPTURE', jobId: 42 })).toBe(false);
  });
});
