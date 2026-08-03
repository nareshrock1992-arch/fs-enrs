/**
 * useConferenceState — owns all socket subscriptions and derived state
 * for the Conference Monitoring Center.
 *
 * Extracted from Monitoring.jsx so the page can be a thin wrapper and
 * every layout/widget component receives clean, typed data as props.
 */
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { api }    from '../../../api/client.js';
import { socket } from '../../../api/socket.js';

const MAX_EVENTS        = 120;
const CHART_INTERVAL_MS = 10_000;
const MAX_CHART_POINTS  = 60;

export function useConferenceState() {
  const [conferences,  setConferences]  = useState([]);
  const [esl,          setEsl]          = useState(null);
  const [events,       setEvents]       = useState([]);
  const [selectedConf, setSelectedConf] = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [eslLatency,   setEslLatency]   = useState(null);
  const [now,          setNow]          = useState(() => Date.now());
  const [lastSync,     setLastSync]     = useState(null);
  const [partHist,     setPartHist]     = useState([0]);
  const [confHist,     setConfHist]     = useState([0]);
  const [evHist,       setEvHist]       = useState([0]);

  const confsRef      = useRef([]);
  const eventCountRef = useRef(0);
  const eventIdRef    = useRef(0);
  // talkTracker: Map<"confName:memberId", { startMs: number|null, totalMs: number }>
  const talkTracker   = useRef(new Map());

  useEffect(() => { confsRef.current = conferences; }, [conferences]);

  // 1-second clock — drives all duration displays
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Sparkline history — sampled every CHART_INTERVAL_MS
  useEffect(() => {
    const t = setInterval(() => {
      const cs    = confsRef.current;
      const total = cs.reduce((s, c) => s + (c.members?.length ?? 0), 0);
      const addPt = (setter, v) => setter(prev => {
        const n = [...prev, v];
        return n.length > MAX_CHART_POINTS ? n.slice(-MAX_CHART_POINTS) : n;
      });
      addPt(setPartHist, total);
      addPt(setConfHist, cs.length);
      addPt(setEvHist,   eventCountRef.current);
      eventCountRef.current = 0;
    }, CHART_INTERVAL_MS);
    return () => clearInterval(t);
  }, []);

  // ESL round-trip latency probe
  useEffect(() => {
    async function ping() {
      const t0 = Date.now();
      try   { await api.monitoring.status(); setEslLatency(Date.now() - t0); }
      catch  { setEslLatency(null); }
    }
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api.monitoring.conferences();
      setConferences(data.conferences || []);
      setEsl(data.esl);
      setLastSync(new Date().toISOString());
    } catch (e) {
      console.error('[monitoring] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pushEvent = useCallback((type, detail) => {
    eventCountRef.current++;
    setEvents(prev => {
      const next = [
        { id: eventIdRef.current++, type, detail, ts: new Date().toISOString() },
        ...prev,
      ];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  // Socket event handlers — registered once, stable via useCallback deps
  useEffect(() => {
    function upConf(name, fn) {
      setConferences(prev => {
        const i = prev.findIndex(c => c.name === name);
        if (i === -1) return prev;
        const next = [...prev];
        next[i] = fn(next[i]);
        return next;
      });
    }
    function upMember(confName, id, fn) {
      upConf(confName, c => ({
        ...c,
        members: c.members.map(m => m.id === id ? fn(m) : m),
      }));
    }

    const handlers = {
      'esl.status': (status) => {
        setEsl(status);
        if (status.connected) setTimeout(load, 1000);
      },

      'conference.created': ({ confName }) => {
        setConferences(prev => {
          if (prev.find(c => c.name === confName)) return prev;
          return [...prev, {
            name: confName, members: [], locked: false,
            recording: false, recordingState: 'OFF',
            recordingPath: null, recordingError: null,
            rate: null, isDynamic: true, isRunning: false,
            isAnswered: false, isModerated: false,
            createdAt: new Date().toISOString(),
          }];
        });
        pushEvent('conference.created', `Conference ${confName} created`);
      },

      'conference.ended': ({ confName }) => {
        for (const key of talkTracker.current.keys()) {
          if (key.startsWith(`${confName}:`)) talkTracker.current.delete(key);
        }
        setConferences(prev => prev.filter(c => c.name !== confName));
        setSelectedConf(s => s === confName ? null : s);
        pushEvent('conference.ended', `Conference ${confName} ended`);
      },

      'conference.member.joined': ({ confName, memberData, callerNum, callerName, member: memberId }) => {
        const data = memberData || {
          id:          memberId || callerNum || String(Date.now()),
          displayName: callerName || callerNum || `Member #${memberId}`,
          extension:   callerNum  || '',
          callerNum:   callerNum  || '',
          callerName:  callerName || '',
          role:        'participant',
          muted: false, deaf: false, moderator: false,
          talking: false, floor: false, energy: 0,
          joinedAt: new Date().toISOString(),
        };
        upConf(confName, c => {
          if (c.members.find(m => m.id === data.id)) return c;
          return { ...c, members: [...c.members, data] };
        });
        const display = data.displayName || callerName || callerNum || 'Member';
        pushEvent('conference.member.joined', `${display} joined ${confName}`);
      },

      'conference.member.left': ({ confName, member: id, callerNum }) => {
        talkTracker.current.delete(`${confName}:${id}`);
        upConf(confName, c => ({ ...c, members: c.members.filter(m => m.id !== id) }));
        pushEvent('conference.member.left', `${callerNum || id} left ${confName}`);
      },

      'conference.member.muted': ({ confName, member: id, muted, callerNum }) => {
        upMember(confName, id, m => ({ ...m, muted }));
        pushEvent('conference.member.muted',
          `${callerNum || id} ${muted ? 'muted' : 'unmuted'} in ${confName}`);
      },

      'conference.member.deaf': ({ confName, member: id, deaf }) => {
        upMember(confName, id, m => ({ ...m, deaf }));
        pushEvent('conference.member.deaf', `Deaf state changed in ${confName}`);
      },

      'conference.member.talking': ({ confName, member: id, talking, callerNum }) => {
        const key     = `${confName}:${id}`;
        const tracker = talkTracker.current;
        if (talking) {
          if (!tracker.has(key)) tracker.set(key, { startMs: Date.now(), totalMs: 0 });
          else tracker.get(key).startMs = Date.now();
        } else {
          const entry = tracker.get(key);
          if (entry?.startMs) {
            entry.totalMs += Date.now() - entry.startMs;
            entry.startMs = null;
          }
        }
        upMember(confName, id, m => ({ ...m, talking }));
        if (talking) pushEvent('conference.member.talking',
          `${callerNum || id} speaking in ${confName}`);
      },

      'conference.member.moderator': ({ confName, member: id, callerNum, moderator }) => {
        upMember(confName, id, m => ({ ...m, moderator }));
        pushEvent('conference.member.moderator',
          `${callerNum || id} ${moderator ? 'promoted to moderator' : 'removed from moderator'} in ${confName}`);
      },

      'conference.floor.changed': ({ confName, member: id }) => {
        const prevHolder = confsRef.current.find(c => c.name === confName)?.floorHolder;
        upConf(confName, c => ({
          ...c,
          floorHolder: id,
          members: c.members.map(m => ({ ...m, floor: m.id === id })),
        }));
        if (prevHolder && prevHolder !== id)
          pushEvent('conference.floor.released',
            `Floor released by member ${prevHolder} in ${confName}`);
        if (id)
          pushEvent('conference.floor.granted',
            `Floor granted to member ${id} in ${confName}`);
      },

      'conference.locked': ({ confName, locked }) => {
        upConf(confName, c => ({ ...c, locked }));
        pushEvent(locked ? 'conference.locked' : 'conference.unlocked',
          `${confName} ${locked ? 'locked' : 'unlocked'}`);
      },

      'conference.member.energy': ({ confName, member: id, energy }) => {
        upMember(confName, id, m => ({ ...m, energy }));
      },

      'conference.recording': ({ confName, recording, recordingState, recordingPath, recordingError }) => {
        upConf(confName, c => ({
          ...c, recording,
          recordingState: recordingState || (recording ? 'ACTIVE' : 'OFF'),
          recordingPath:  recordingPath  ?? c.recordingPath,
          recordingError: recordingError ?? (recordingState === 'FAILED' ? c.recordingError : null),
        }));
        const state = recordingState || (recording ? 'ACTIVE' : 'OFF');
        const label = state === 'STARTING' ? 'starting'
          : state === 'ACTIVE' ? 'started'
          : state === 'FAILED' ? 'FAILED' : 'stopped';
        pushEvent('conference.recording',
          state === 'FAILED'
            ? `${confName}: recording FAILED — ${recordingError || 'unknown error'}`
            : `${confName}: recording ${label}`);
      },
    };

    for (const [ev, fn] of Object.entries(handlers)) socket.on(ev, fn);
    return () => {
      for (const [ev, fn] of Object.entries(handlers)) socket.off(ev, fn);
    };
  }, [pushEvent, load]);

  // Derived totals
  const totalMembers = useMemo(
    () => conferences.reduce((s, c) => s + (c.members?.length ?? 0), 0),
    [conferences],
  );
  const totalModerators = useMemo(
    () => conferences.reduce((s, c) => s + (c.members?.filter(m => m.moderator).length ?? 0), 0),
    [conferences],
  );
  const recordingCount = useMemo(
    () => conferences.filter(c => c.recordingState === 'ACTIVE').length,
    [conferences],
  );
  const selectedConference = useMemo(
    () => conferences.find(c => c.name === selectedConf) ?? null,
    [conferences, selectedConf],
  );

  return {
    // Raw state
    conferences, esl, events, eslLatency, loading, now, lastSync,
    // Selection
    selectedConf, setSelectedConf, selectedConference,
    // Actions
    reload: load,
    // Talk time tracking ref (passed to ParticipantTableWidget)
    talkTracker,
    // Sparkline history arrays
    partHist, confHist, evHist,
    // KPI totals
    totalMembers, totalModerators, recordingCount,
    // Chart interval constant (for sparkline labels)
    chartIntervalMs: CHART_INTERVAL_MS,
  };
}
