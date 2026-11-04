// Numbers shown for a campaign. Recipient outcomes (from the API's `outcomes`, one final
// outcome per recipient) are used when present: they match the ENS report and its export.
// The counters stored on the campaign count dial ATTEMPTS (a busy recipient retried three
// times is three), so they are only a fallback for an API that does not send outcomes.
export function campaignCounts(c = {}) {
  const o = c.outcomes;
  if (o && typeof o === 'object' && o.recipients != null) {
    const n = (k) => Number(o[k]) || 0;
    const total = n('recipients');
    const pending = n('pending');
    return {
      source: 'recipients',
      total,
      answered: n('answered'), busy: n('busy'), noAnswer: n('no_answer'), failed: n('failed'),
      expired: n('expired'), skipped: n('skipped'), pending,
      done: Math.max(0, total - pending),
      retries: n('retries'),
    };
  }
  const n = (k) => Number(c[k]) || 0;
  const total = n('total_destinations');
  const done = n('completed_count') + n('failed_count') + n('expired_count') + n('skipped_count');
  return {
    source: 'counters',
    total,
    answered: n('answered_count'), busy: n('busy_count'), noAnswer: n('no_answer_count'), failed: n('failed_count'),
    expired: n('expired_count'), skipped: n('skipped_count'), pending: Math.max(0, total - done),
    done,
    retries: n('retried_count'),
  };
}
