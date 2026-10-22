// ── IVR builder autosave policy + controller ─────────────────────────────────
//
// Pure (no React) so it can be unit-tested directly. useIvrGraph wires it to
// its reducer state; the controller owns the timer and the single in-flight
// request.
//
// Rules:
//   - Never more than one save request in flight; a manual save waits for it.
//   - A response for a flow that is no longer loaded (unmount / re-seed) is ignored.
//   - A save only clears `dirty` if no edit happened while it was in flight
//     (revision check in the reducer's MARK_SAVED).
//   - Permanent errors (4xx — e.g. 409 MEDIA_DELETED, 400 validation) are not
//     retried automatically: autosave pauses until the graph changes again or
//     the user clicks Save.
//   - Transient errors (network / timeout / 5xx — e.g. 503 MEDIA_BUSY) retry
//     with bounded exponential backoff, then pause after MAX_TRANSIENT_FAILURES.
//   - The graph stays dirty on every failure; nothing is ever marked saved
//     without a successful response.

export const AUTOSAVE_DEBOUNCE_MS   = 800;
export const RETRY_BASE_MS          = 2000;
export const RETRY_MAX_MS           = 30000;
export const MAX_TRANSIENT_FAILURES = 5;

export const INITIAL_SAVE_STATUS = Object.freeze({ failures: 0, kind: null, blockedRev: null });

/** 'transient' (worth retrying automatically) or 'permanent'. */
export function classifySaveError(err) {
  const status = err?.status;
  if (!status) return 'transient';                                   // network error / no response
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'transient';
  return 'permanent';
}

/** Backoff for the n-th consecutive transient failure (n ≥ 1). */
export function retryDelayMs(failures) {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Delay before the next automatic save, or null when no automatic save should
 * be scheduled (clean, already saving, no flow loaded, or paused at this revision).
 */
export function autosaveDelayMs(state) {
  if (!state?.dirty || state.saving || !state.flowMeta?.flow_uuid) return null;
  const st = state.saveStatus || INITIAL_SAVE_STATUS;
  if (st.blockedRev !== null && st.blockedRev === state.rev) return null;
  if (st.kind === 'transient' && st.failures > 0) return Math.max(AUTOSAVE_DEBOUNCE_MS, retryDelayMs(st.failures));
  return AUTOSAVE_DEBOUNCE_MS;
}

/** Next save status after a failed save of revision `rev`. */
export function nextSaveStatus(status, err, rev) {
  const prev = status || INITIAL_SAVE_STATUS;
  const kind = classifySaveError(err);
  const failures = kind === 'transient' ? prev.failures + 1 : prev.failures;
  const paused = kind === 'permanent' || failures >= MAX_TRANSIENT_FAILURES;
  return { failures, kind, blockedRev: paused ? rev : null };
}

/** Human message for the toolbar ("Save failed" tooltip). */
export function describeSaveFailure(err, status) {
  const base = err?.data?.errors?.[0] || err?.data?.message || err?.message || 'Save failed';
  if (status.kind === 'permanent') {
    return `${base} — changes are NOT saved. Autosave is paused until you edit the flow or click Save.`;
  }
  if (status.blockedRev !== null) {
    return `${base} — changes are NOT saved. Autosave paused after ${status.failures} failed attempts; click Save to retry.`;
  }
  return `${base} — changes are NOT saved yet; retrying in ${Math.round(retryDelayMs(status.failures) / 1000)}s.`;
}

/**
 * @param getState  () => current reducer state ({ dirty, saving, rev, seedEpoch, saveStatus, flowMeta, … })
 * @param dispatch  reducer dispatch
 * @param save      (flowUuid, stateSnapshot) => Promise — performs the API call
 */
export function createAutosaveController({
  getState, dispatch, save,
  setTimer = setTimeout, clearTimer = clearTimeout, log = console,
}) {
  let timer = null;
  let inFlight = null;
  let active = true;

  const cancel = () => { if (timer) { clearTimer(timer); timer = null; } };

  async function run({ manual = false } = {}) {
    cancel();
    while (inFlight) {                       // never overlap: wait for the current request
      await inFlight;
      if (!active) return;
    }
    cancel();                                // a timer armed by the previous save's result is superseded
    const s = getState();
    if (!active || !s?.dirty || !s.flowMeta?.flow_uuid) return;
    if (!manual && autosaveDelayMs(s) === null) return;   // paused (or saving): idle until a change / manual save

    const flowUuid = s.flowMeta.flow_uuid;
    const rev = s.rev;
    const epoch = s.seedEpoch;
    let error = null;
    dispatch({ type: 'MARK_SAVING' });
    inFlight = Promise.resolve().then(() => save(flowUuid, s)).then(() => {}, (e) => { error = e; });
    await inFlight;
    inFlight = null;

    const now = getState();
    if (!active || now?.flowMeta?.flow_uuid !== flowUuid || now?.seedEpoch !== epoch) return;   // stale response
    if (!error) { dispatch({ type: 'MARK_SAVED', rev }); return; }

    log?.error?.('[ivr] save failed', error);
    const status = nextSaveStatus(now.saveStatus, error, rev);
    dispatch({ type: 'MARK_SAVE_ERROR', message: describeSaveFailure(error, status), status });
    if (manual) throw error;
  }

  /** (Re)arm the debounce/backoff timer from the current state. */
  function schedule() {
    cancel();
    if (!active || inFlight) return;
    const delay = autosaveDelayMs(getState());
    if (delay === null) return;
    timer = setTimer(() => { timer = null; run().catch(() => {}); }, delay);
  }

  return {
    run,
    schedule,
    activate() { active = true; },
    dispose() { active = false; cancel(); },
    get inFlight() { return !!inFlight; },
  };
}
