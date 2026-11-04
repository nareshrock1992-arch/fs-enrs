// Recipient outcomes for ENS campaigns, shared by the reports and the campaign dashboard
// so both count the same thing.
// One final outcome per recipient, from ens_campaign_destinations. The counters on
// ens_campaigns are not used: busy_count / no_answer_count count retried ATTEMPTS, and
// expiring a campaign does not update them. The cause lists mirror BUSY_CAUSES and
// RETRYABLE_CAUSES in services/campaignEngine.js (reportsRoutes.test.js keeps them equal).
export const BUSY_CAUSE_LIST = ['BUSY', 'USER_BUSY', 'NORMAL_CIRCUIT_CONGESTION', 'SWITCH_CONGESTION'];
export const NO_ANSWER_CAUSE_LIST = ['NO_ANSWER', 'NO_USER_RESPONSE', 'ALLOTTED_TIMEOUT', 'ORIGINATOR_CANCEL',
  'CALL_REJECTED', 'SUBSCRIBER_ABSENT'];
const sqlList = (list) => list.map((c) => `'${c}'`).join(',');

export const DESTINATION_OUTCOME_SQL = `CASE
    WHEN d.answered_at IS NOT NULL            THEN 'answered'
    WHEN d.status IN ('queued','dialing')     THEN 'pending'
    WHEN d.status = 'expired'                 THEN 'expired'
    WHEN d.status = 'skipped'                 THEN 'skipped'
    WHEN d.hangup_cause IN (${sqlList(BUSY_CAUSE_LIST)})      THEN 'busy'
    WHEN d.hangup_cause IN (${sqlList(NO_ANSWER_CAUSE_LIST)}) THEN 'no_answer'
    ELSE 'failed' END`;

// Adds recipients, answered, busy, no_answer, failed, expired, skipped, pending,
// attempts, retries, avg_answer_sec for campaign alias c, as alias x.
export const CAMPAIGN_OUTCOMES_JOIN = `LEFT JOIN LATERAL (
    SELECT COUNT(*)::INT AS recipients,
           COUNT(*) FILTER (WHERE o.outcome = 'answered')::INT  AS answered,
           COUNT(*) FILTER (WHERE o.outcome = 'busy')::INT      AS busy,
           COUNT(*) FILTER (WHERE o.outcome = 'no_answer')::INT AS no_answer,
           COUNT(*) FILTER (WHERE o.outcome = 'failed')::INT    AS failed,
           COUNT(*) FILTER (WHERE o.outcome = 'expired')::INT   AS expired,
           COUNT(*) FILTER (WHERE o.outcome = 'skipped')::INT   AS skipped,
           COUNT(*) FILTER (WHERE o.outcome = 'pending')::INT   AS pending,
           COALESCE(SUM(o.attempt_count), 0)::INT               AS attempts,
           COALESCE(SUM(GREATEST(o.attempt_count - 1, 0)), 0)::INT AS retries,
           ROUND(AVG(EXTRACT(EPOCH FROM (o.answered_at - o.last_attempt_at)))
                 FILTER (WHERE o.answered_at >= o.last_attempt_at))::INT AS avg_answer_sec
      FROM (SELECT d.attempt_count, d.answered_at, d.last_attempt_at, ${DESTINATION_OUTCOME_SQL} AS outcome
              FROM ens_campaign_destinations d WHERE d.campaign_id = c.id) o
  ) x ON true`;
