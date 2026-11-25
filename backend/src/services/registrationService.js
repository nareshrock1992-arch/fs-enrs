/**
 * Phone registrations (read-only) — which phones are signed in to FreeSWITCH, from where.
 *
 * Reads `sofia xmlstatus` (profile list) and `sofia xmlstatus profile <name> reg` through the
 * existing ESL connection. Never changes FreeSWITCH. Parsing is pure and unit-tested; FreeSWITCH's
 * XML is flat and machine-generated, so a small tag reader is enough (no XML dependency).
 *
 * MAC address: SIP has no standard field for it. Many desk phones report it in the
 * `+sip.instance` contact parameter (urn:uuid:00000000-0000-1000-8000-<MAC>) or in their
 * User-Agent string; softphones and browsers usually do not. When nothing is reported, mac = null.
 */
import { eslCommand } from './eslService.js';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const decode = (s) => String(s ?? '').replace(/&(lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m]).trim();

/** All <tag>…</tag> bodies inside `xml`, in order. */
function blocks(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(String(xml ?? '')))) out.push(m[1]);
  return out;
}
const field = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decode(m[1]) : '';
};

/** A FreeSWITCH profile name we are willing to put into a command. */
export const SAFE_PROFILE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Unique SIP profile names from `sofia xmlstatus` (a profile is listed once per listening port). */
export function parseProfiles(xml) {
  const names = new Set();
  for (const p of blocks(xml, 'profile')) {
    if (field(p, 'type') !== 'profile') continue;
    const name = field(p, 'name');
    if (SAFE_PROFILE.test(name)) names.add(name);
  }
  return [...names];
}

const MAC_HEX = /^[0-9a-f]{12}$/i;
const fmtMac = (hex) => hex.toUpperCase().match(/.{2}/g).join(':');

/**
 * MAC address reported by the phone, or null.
 * 1. contact `+sip.instance="<urn:uuid:00000000-0000-1000-8000-XXXXXXXXXXXX>"` (RFC 5626 style used by
 *    Yealink, Polycom, Grandstream…) — only when the uuid has the all-zero prefix, i.e. is MAC-based.
 * 2. a MAC written with separators in the User-Agent: 80:5e:c0:12:34:ab or 80-5E-C0-12-34-AB.
 * 3. a bare 12-hex token in the User-Agent that contains letters, e.g. "(805ec01234ab)" — plain
 *    12-digit numbers are ignored because they are usually firmware versions.
 */
export function extractMac(agent = '', contact = '') {
  const inst = /urn:uuid:00000000-0000-1000-8000-([0-9a-f]{12})/i.exec(contact);
  if (inst) return fmtMac(inst[1]);
  const sep = /(?:^|[^0-9a-f])((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})(?![0-9a-f])/i.exec(agent);
  if (sep) return fmtMac(sep[1].replace(/[:-]/g, ''));
  for (const tok of agent.split(/[\s()[\],;/]+/)) {
    if (MAC_HEX.test(tok) && /[a-f]/i.test(tok) && /\d/.test(tok)) return fmtMac(tok);
  }
  return null;
}

/** "Registered(WSS-NAT)(unknown) exp(2026-11-25 06:37:54) expsecs(265)" → parts. */
export function parseStatus(status = '') {
  const t = /Registered\(([A-Z]+)(-NAT)?\)/i.exec(status);
  const secs = /expsecs\((-?\d+)\)/.exec(status);
  return {
    registered: /^Registered/i.test(status),
    transport: t ? t[1].toUpperCase() : null,
    nat: Boolean(t?.[2]),
    expiresIn: secs ? Number(secs[1]) : null,
  };
}

/** One sofia profile's `reg` XML → registration rows (no call-id: not needed, not shown). */
export function parseRegistrations(xml, profile) {
  return blocks(xml, 'registration').map((r) => {
    const user = field(r, 'user');
    const [extension, realm = ''] = user.split('@');
    const agent = field(r, 'agent');
    const contact = field(r, 'contact');
    const st = parseStatus(field(r, 'status'));
    const pingStatus = field(r, 'ping-status');
    const pingMs = Number(field(r, 'ping-time'));
    const browserPhone = st.transport === 'WS' || st.transport === 'WSS' || /^FS-WebRTC\b/.test(agent);
    return {
      profile,
      extension: field(r, 'sip-auth-user') || extension,
      realm: field(r, 'sip-auth-realm') || realm,
      device: agent || null,
      ip: field(r, 'network-ip') || null,
      port: Number(field(r, 'network-port')) || null,
      transport: st.transport,
      nat: st.nat,
      expiresIn: st.expiresIn,
      reachable: pingStatus ? /^reachable$/i.test(pingStatus) : null,
      pingMs: Number.isFinite(pingMs) ? Math.round(pingMs) : null,
      mac: extractMac(agent, contact),
      browserPhone,
      contact,
    };
  });
}

/** Marks extensions registered more than once and builds the counters. */
export function summarise(rows) {
  const count = new Map();
  for (const r of rows) count.set(r.extension, (count.get(r.extension) || 0) + 1);
  const list = rows
    .map((r) => ({ ...r, duplicate: count.get(r.extension) > 1 }))
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }) || String(a.ip).localeCompare(String(b.ip)));
  return {
    summary: {
      registered: list.length,
      notReachable: list.filter((r) => r.reachable === false).length,
      browserPhones: list.filter((r) => r.browserPhone).length,
      duplicateExtensions: [...count.values()].filter((n) => n > 1).length,
    },
    registrations: list,
  };
}

/**
 * SIP trunks (gateways) from `sofia xmlstatus gateway`. Only safe fields are copied: the XML also
 * carries the trunk's username and PASSWORD, which must never leave the server.
 */
export function parseGateways(xml) {
  const num = (s) => (s === '' ? null : Number(s));
  return blocks(xml, 'gateway').map((g) => {
    const uptime = num(field(g, 'uptime-usec'));
    const pingMs = num(field(g, 'pingtime'));
    return {
      name: field(g, 'name'),
      profile: field(g, 'profile') || null,
      proxy: field(g, 'proxy') || null,
      realm: field(g, 'realm') || null,
      registration: field(g, 'state') || null,      // REGED, NOREG, TRYING, FAILED, FAIL_WAIT, UNREGED…
      status: field(g, 'status') || null,           // UP / DOWN (options-ping result)
      pingMs: Number.isFinite(pingMs) && field(g, 'pingfreq') !== '0' ? Math.round(pingMs) : null,
      uptimeSeconds: Number.isFinite(uptime) ? Math.floor(uptime / 1e6) : null,
      callsIn: num(field(g, 'calls-in')),
      callsOut: num(field(g, 'calls-out')),
      failedIn: num(field(g, 'failed-calls-in')),
      failedOut: num(field(g, 'failed-calls-out')),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** A trunk needs attention: down, or it should register and is not registered. */
export function gatewayProblem(g) {
  if (g.status && g.status !== 'UP') return 'down';
  if (g.registration && /FAIL|UNREGED|EXPIRED/.test(g.registration)) return 'not registered';
  return null;
}

/** Live SIP trunks. Throws when FreeSWITCH cannot be asked. */
export async function fetchGateways(command = eslCommand) {
  return parseGateways(await command('sofia xmlstatus gateway'));
}

/** Live registrations of every SIP profile. Throws when FreeSWITCH cannot be asked. */
export async function fetchRegistrations(command = eslCommand) {
  const profiles = parseProfiles(await command('sofia xmlstatus'));
  const rows = [];
  for (const p of profiles) {
    if (!SAFE_PROFILE.test(p)) continue; // defence in depth: never interpolate anything else
    rows.push(...parseRegistrations(await command(`sofia xmlstatus profile ${p} reg`), p));
  }
  return rows;
}
