// IVR builder autosave — bounded, state-aware retry (media-safety remediation, Phase A).
// Drives the real reducer (useIvrGraph.js) + the real controller (hooks/autosave.js)
// with injected timers; the effect that calls schedule() is emulated by
// re-scheduling after every dispatch, exactly as the hook's effect does on
// dirty / saving / rev / saveStatus / flow changes.
import { describe, it, expect } from 'vitest';
import { reducer } from '../hooks/useIvrGraph.js';
import {
  createAutosaveController, classifySaveError, retryDelayMs, MAX_TRANSIENT_FAILURES, AUTOSAVE_DEBOUNCE_MS,
} from '../hooks/autosave.js';

const FLOW = { flow_uuid: 'f-1', graph: { entry_node_id: 'h', nodes: { h: { type: 'hangup' } } } };
const httpErr = (status, data = {}) => Object.assign(new Error(data.error || `HTTP ${status}`), { status, data });

function harness(saveImpl) {
  let state = reducer({}, { type: 'SEED', flow: FLOW });
  const timers = [];                         // pending { fn, delay }
  const saves = [];                          // { flowUuid, rev, resolve, reject }
  let ctl;
  const dispatch = (a) => { state = reducer(state, a); ctl?.schedule(); };
  ctl = createAutosaveController({
    getState: () => state,
    dispatch,
    save: (flowUuid, s) => saveImpl({ flowUuid, rev: s.rev, saves }),
    setTimer: (fn, delay) => { const t = { fn, delay }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    log: null,
  });
  const edit = (x) => dispatch({ type: 'MOVE_VIEWPORT', viewport: { x, y: 0, zoom: 1 } });
  const fireTimer = async () => {
    const t = timers.shift(); if (!t) return null;
    t.fn(); await flush(); return t.delay;
  };
  return { get state() { return state; }, timers, saves, ctl, edit, dispatch, fireTimer };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const resolving = () => ({ saves }) => { saves.push(1); return Promise.resolve(); };
const rejecting = (err) => ({ saves }) => { saves.push(1); return Promise.reject(err); };

describe('autosave — classification & backoff', () => {
  it('4xx are permanent; network / timeout / 5xx are transient', () => {
    expect(classifySaveError(httpErr(409, { error: 'MEDIA_DELETED' }))).toBe('permanent');
    expect(classifySaveError(httpErr(400))).toBe('permanent');
    expect(classifySaveError(httpErr(503, { error: 'MEDIA_BUSY' }))).toBe('transient');
    expect(classifySaveError(httpErr(500))).toBe('transient');
    expect(classifySaveError(new TypeError('Failed to fetch'))).toBe('transient');
  });
  it('backoff is exponential and capped', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe('autosave — controller + reducer', () => {
  it('successful autosave: one save after the debounce, then clean', async () => {
    const h = harness(resolving());
    h.edit(1);
    expect(h.timers.map((t) => t.delay)).toEqual([AUTOSAVE_DEBOUNCE_MS]);
    await h.fireTimer();
    expect(h.saves.length).toBe(1);
    expect(h.state.dirty).toBe(false);
    expect(h.state.saveError).toBe(null);
    expect(h.timers.length).toBe(0);
  });

  it('persistent 409 MEDIA_DELETED: one attempt, then paused — no retries while idle, graph stays dirty', async () => {
    const h = harness(rejecting(httpErr(409, { error: 'MEDIA_DELETED', message: 'This change references media that has been deleted.' })));
    h.edit(1);
    await h.fireTimer();
    expect(h.saves.length).toBe(1);
    expect(h.state.dirty).toBe(true);
    expect(h.state.saveError).toMatch(/references media that has been deleted.*NOT saved.*paused/);
    expect(h.timers.length).toBe(0);                    // idle: nothing scheduled
    h.ctl.schedule(); h.ctl.schedule();                 // extra effect runs change nothing
    expect(h.timers.length).toBe(0);
    expect(h.saves.length).toBe(1);
  });

  it('a graph change after a permanent failure re-enables autosave (one new attempt)', async () => {
    const h = harness(rejecting(httpErr(409, { error: 'MEDIA_DELETED' })));
    h.edit(1); await h.fireTimer();
    h.edit(2);
    expect(h.timers.map((t) => t.delay)).toEqual([AUTOSAVE_DEBOUNCE_MS]);
    await h.fireTimer();
    expect(h.saves.length).toBe(2);
    expect(h.timers.length).toBe(0);                    // paused again at the new revision
  });

  it('persistent 503: bounded backoff, then paused after MAX_TRANSIENT_FAILURES attempts', async () => {
    const h = harness(rejecting(httpErr(503, { error: 'MEDIA_BUSY', message: 'A referenced media file is being changed right now.' })));
    h.edit(1);
    const delays = [];
    for (let i = 0; i < 20; i++) { const d = await h.fireTimer(); if (d === null) break; delays.push(d); }
    expect(delays).toEqual([800, 2000, 4000, 8000, 16000]);
    expect(h.saves.length).toBe(MAX_TRANSIENT_FAILURES);
    expect(h.state.dirty).toBe(true);
    expect(h.state.saveError).toMatch(/NOT saved.*paused after 5 failed attempts/);
    expect(h.timers.length).toBe(0);
  });

  it('transient failure followed by success: retried once after backoff, then clean', async () => {
    let n = 0;
    const h = harness(({ saves }) => { saves.push(1); return ++n === 1 ? Promise.reject(httpErr(503)) : Promise.resolve(); });
    h.edit(1); await h.fireTimer();
    expect(h.state.saveError).toMatch(/retrying in 2s/);
    expect(h.timers.map((t) => t.delay)).toEqual([2000]);
    await h.fireTimer();
    expect(h.saves.length).toBe(2);
    expect(h.state.dirty).toBe(false);
    expect(h.state.saveStatus.failures).toBe(0);
  });

  it('no overlapping saves: a manual save waits for the in-flight autosave', async () => {
    let inFlight = 0, maxInFlight = 0; const pending = [];
    const h = harness(({ saves }) => {
      saves.push(1); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((res) => pending.push(() => { inFlight--; res(); }));
    });
    h.edit(1);
    const auto = h.timers.shift().fn();                // autosave starts (still pending)
    await flush();
    h.edit(2);                                          // edit while in flight
    const manual = h.ctl.run({ manual: true });
    await flush();
    expect(h.saves.length).toBe(1);                     // manual has NOT started a second request
    pending.shift()(); await flush(); await flush();
    expect(h.saves.length).toBe(2);                     // …it runs after the first completes
    pending.shift()(); await manual; await auto;
    expect(maxInFlight).toBe(1);
    expect(h.state.dirty).toBe(false);
  });

  it('an edit made while a save is in flight is NOT marked saved', async () => {
    const pending = [];
    const h = harness(({ saves }) => { saves.push(1); return new Promise((res) => pending.push(res)); });
    h.edit(1);
    h.timers.shift().fn(); await flush();
    h.edit(2);                                          // rev bumps during the request
    pending.shift()(); await flush();
    expect(h.state.dirty).toBe(true);                   // newer edit still unsaved
    expect(h.timers.map((t) => t.delay)).toEqual([AUTOSAVE_DEBOUNCE_MS]);
    await h.fireTimer(); pending.shift()(); await flush();
    expect(h.saves.length).toBe(2);
    expect(h.state.dirty).toBe(false);
  });

  it('stale responses are ignored: after unmount (dispose) and after a re-seed', async () => {
    const pending = [];
    const a = harness(({ saves }) => { saves.push(1); return new Promise((_, rej) => pending.push(rej)); });
    a.edit(1); a.timers.shift().fn(); await flush();
    a.ctl.dispose();
    pending.shift()(httpErr(503)); await flush();
    expect(a.state.saveError).toBe(null);               // no dispatch after unmount
    expect(a.timers.length).toBe(0);

    const b = harness(({ saves }) => { saves.push(1); return new Promise((_, rej) => pending.push(rej)); });
    b.edit(1); b.timers.shift().fn(); await flush();
    b.dispatch({ type: 'SEED', flow: FLOW });           // flow reloaded (e.g. version restore)
    pending.shift()(httpErr(409)); await flush();
    expect(b.state.saveError).toBe(null);
    expect(b.state.dirty).toBe(false);
  });

  it('manual Save retries a paused save and reports failure to the caller', async () => {
    const h = harness(rejecting(httpErr(409, { error: 'MEDIA_DELETED' })));
    h.edit(1); await h.fireTimer();
    expect(h.timers.length).toBe(0);
    await expect(h.ctl.run({ manual: true })).rejects.toMatchObject({ status: 409 });
    expect(h.saves.length).toBe(2);
    expect(h.state.dirty).toBe(true);
  });
});
