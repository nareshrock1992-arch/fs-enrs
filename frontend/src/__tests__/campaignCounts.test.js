import { describe, it, expect } from 'vitest';
import { campaignCounts } from '../pages/ens/campaignCounts.js';

describe('campaign numbers', () => {
  it('uses recipient outcomes when the API sends them, not the attempt counters', () => {
    const c = {
      total_destinations: 6, answered_count: 0, busy_count: 7, failed_count: 0,
      outcomes: { recipients: 6, answered: 3, busy: 1, no_answer: 1, failed: 0, expired: 1, skipped: 0, pending: 0, retries: 4 },
    };
    expect(campaignCounts(c)).toMatchObject({ source: 'recipients', total: 6, answered: 3, busy: 1, noAnswer: 1, expired: 1, done: 6, pending: 0, retries: 4 });
  });
  it('counts unfinished recipients as pending', () => {
    expect(campaignCounts({ outcomes: { recipients: 10, answered: 2, pending: 7, failed: 1 } })).toMatchObject({ done: 3, pending: 7 });
  });
  it('falls back to the stored counters only without outcomes', () => {
    expect(campaignCounts({ total_destinations: 4, completed_count: 2, failed_count: 1, answered_count: 2 }))
      .toMatchObject({ source: 'counters', total: 4, done: 3, pending: 1, answered: 2 });
    expect(campaignCounts()).toMatchObject({ total: 0, done: 0, pending: 0 });
  });
});
