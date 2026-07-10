import { describe, it, expect, vi } from 'vitest';
import { verifyExtensionLoaded } from '../../services/eslService.js';

// Regression guard for Phase 1 item 10: verify_extension_loaded produced
// false-negative failures during real testing — a reload that manual
// re-verification proved had actually succeeded was reported as failed.
// Two root causes, both covered here:
//   1. xml_locate was called with 2 args ("xml_locate dialplan default"),
//      not the valid 4-arg form (section, tag_name, key_name, key_value).
//   2. No retry — a real race where reloadxml's ESL response can return
//      before FreeSWITCH finishes re-parsing internally.

describe('verifyExtensionLoaded — retry behavior', () => {
  it('succeeds immediately when the extension is found on the first attempt', async () => {
    const locateFn = vi.fn().mockResolvedValue('<extension name="enrs_ivr_1222">...</extension>');
    const result = await verifyExtensionLoaded('enrs_ivr_1222', { attempts: 3, delayMs: 1, locateFn });
    expect(result.loaded).toBe(true);
    expect(result.attempts).toBe(1);
    expect(locateFn).toHaveBeenCalledTimes(1);
  });

  it('retries up to the configured attempt count before giving up, not failing on the first empty result', async () => {
    // Simulates the exact race this was written for: the first two
    // xml_locate calls return before FreeSWITCH has finished reparsing,
    // the third (after reloadxml settles) finds it.
    const locateFn = vi.fn()
      .mockResolvedValueOnce('<dialplan/>') // not loaded yet
      .mockResolvedValueOnce('<dialplan/>') // still not loaded
      .mockResolvedValueOnce('<extension name="enrs_ivr_1222">...</extension>'); // now loaded

    const result = await verifyExtensionLoaded('enrs_ivr_1222', { attempts: 3, delayMs: 1, locateFn });
    expect(result.loaded).toBe(true);
    expect(result.attempts).toBe(3);
    expect(locateFn).toHaveBeenCalledTimes(3);
  });

  it('reports failure only after exhausting every retry attempt', async () => {
    const locateFn = vi.fn().mockResolvedValue('<dialplan/>'); // never contains the extension
    const result = await verifyExtensionLoaded('enrs_ivr_1222', { attempts: 3, delayMs: 1, locateFn });
    expect(result.loaded).toBe(false);
    expect(locateFn).toHaveBeenCalledTimes(3);
  });

  it('recovers from a transient error on an earlier attempt', async () => {
    const locateFn = vi.fn()
      .mockRejectedValueOnce(new Error('ESL not connected'))
      .mockResolvedValueOnce('<extension name="enrs_ivr_1222">...</extension>');
    const result = await verifyExtensionLoaded('enrs_ivr_1222', { attempts: 3, delayMs: 1, locateFn });
    expect(result.loaded).toBe(true);
    expect(locateFn).toHaveBeenCalledTimes(2);
  });
});

describe('verifyExtensionLoaded — xml_locate argument form', () => {
  it('uses the correct 4-argument xml_locate invocation, not the broken 2-arg form', async () => {
    // eslCommand is not mocked here — this test asserts against the source
    // string directly to lock in the exact command, since the real command
    // can only be proven correct against a live FreeSWITCH (which this
    // environment does not have).
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const filePath = fileURLToPath(new URL('../../services/eslService.js', import.meta.url));
    const content = readFileSync(filePath, 'utf8');
    expect(content).toContain("eslCommand('xml_locate dialplan context name default')");
    expect(content).not.toContain("eslCommand('xml_locate dialplan default')");
  });
});
