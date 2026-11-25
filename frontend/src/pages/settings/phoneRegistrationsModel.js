// Phone registrations page — pure helpers (labels, search). Admin words, not FreeSWITCH codes.

const TRANSPORT_WORDS = { UDP: 'UDP', TCP: 'TCP', TLS: 'TLS (encrypted)', WS: 'Web (WS)', WSS: 'Secure web (WSS)' };

/** "UDP · behind NAT", "Secure web (WSS)" … */
export function connectionLabel(r) {
  const t = TRANSPORT_WORDS[r?.transport] || r?.transport || 'Unknown';
  return r?.nat ? `${t} · behind NAT` : t;
}

/** "MicroSIP/3.21.6" → "MicroSIP 3.21.6"; browser phones get a clear name. */
export function deviceLabel(r) {
  if (r?.browserPhone) return 'Browser phone (FS-CC)';
  if (!r?.device) return 'Unknown device';
  return r.device.replace(/^([A-Za-z][\w .-]*?)\/(\d[\w.-]*)/, '$1 $2');
}

/** Address as the admin needs it; browser phones reach FreeSWITCH through the FS-CC relay. */
export function addressLabel(r) {
  if (r?.browserPhone) return 'via FS-CC relay';
  if (!r?.ip) return '—';
  return r.port ? `${r.ip}:${r.port}` : r.ip;
}

const SLOW_MS = 200;

/** Health: { tone: 'ok'|'warn'|'bad'|'muted', text } */
export function healthOf(r) {
  const left = Number.isFinite(r?.expiresIn) ? ` · ${Math.max(0, r.expiresIn)} s left` : '';
  if (r?.reachable === false) return { tone: 'bad', text: 'Not answering' };
  if (Number.isFinite(r?.pingMs) && r.pingMs >= SLOW_MS) return { tone: 'warn', text: `Slow · ${r.pingMs} ms` };
  if (r?.reachable === true) return { tone: 'ok', text: `Reachable${left}` };
  return { tone: 'muted', text: `Registered${left}` };
}

const TRUNK_REG_WORDS = {
  REGED: 'Registered', NOREG: 'No registration needed', UNREGED: 'Not registered', TRYING: 'Registering…',
  REGISTER: 'Registering…', FAILED: 'Registration failed', FAIL_WAIT: 'Registration failed, retrying',
  EXPIRED: 'Registration expired', UNREGISTER: 'Signing out…', DOWN: 'Down',
};

/** Trunk state in plain words. */
export function trunkLabel(g) {
  if (g?.problem === 'down') return { tone: 'bad', text: 'Down' };
  const reg = TRUNK_REG_WORDS[g?.registration] || g?.registration || 'Unknown';
  if (g?.problem) return { tone: 'bad', text: reg };
  return { tone: 'ok', text: g?.status === 'UP' ? `Up · ${reg}` : reg };
}

/** "4 d 14 h", "3 h 5 m", "42 s" */
export function uptimeLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} m`;
  if (m) return `${m} m`;
  return `${seconds} s`;
}

/** Case-insensitive search over extension, IP, device and MAC (with or without separators). */
export function matchesSearch(r, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  const compact = s.replace(/[:-]/g, '');
  const hay = [r.extension, r.ip, r.device, deviceLabel(r), r.mac, r.realm].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(s) || (compact.length >= 4 && String(r.mac || '').toLowerCase().replace(/:/g, '').includes(compact));
}
