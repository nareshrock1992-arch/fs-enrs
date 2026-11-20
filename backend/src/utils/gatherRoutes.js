// Digits-mode routes for the Gather DTMF node (DTMF redesign, D3–D5).
//
// Pure functions, no I/O. The runtime equivalent lives in the gather luaHandler
// (registry.js: gather_regex_to_lua / gather_route_matches / gather_route_target);
// frontend/src/components/ivr/panels/menu/gatherRoutes.js mirrors this file and a
// parity test keeps the three in step.

export const ROUTE_TYPES = Object.freeze(['equals', 'one_of', 'range', 'starts_with', 'length', 'pattern']);
export const MAX_ROUTES = 20;
export const ROUTE_ID_RE = /^[a-z0-9]{1,8}$/;
export const routeBranchKey = id => `route_${id}`;

/**
 * Safe regex subset → Lua pattern (same algorithm as gather_regex_to_lua).
 * Returns null for anything outside the subset (groups, alternation, …).
 */
export function regexToLuaPattern(rx) {
  if (typeof rx !== 'string' || rx === '') return null;
  const out = [];
  let i = 0;
  const n = rx.length;
  while (i < n) {
    const c = rx[i];
    if (c === '^' && i === 0) { out.push('^'); i += 1; continue; }
    if (c === '$' && i === n - 1) { out.push('$'); i += 1; continue; }
    let atom;
    if (c === '\\') {
      const e = rx[i + 1] ?? '';
      if (e === 'd') atom = '%d';
      else if (e !== '' && '*#.+?'.includes(e)) atom = `%${e}`;
      else return null;
      i += 2;
    } else if (c === '[') {
      const j = rx.indexOf(']', i + 1);
      if (j < 0) return null;
      const body = rx.slice(i + 1, j).replace(/\\d/g, '%d');
      if (body === '' || /[[\]()|]/.test(body)) return null;
      atom = `[${body}]`;
      i = j + 1;
    } else if (c === '.') {
      atom = '.'; i += 1;
    } else if (/[0-9#]/.test(c)) {
      atom = c; i += 1;
    } else if ('*+?()|{}$^'.includes(c)) {
      return null;
    } else {
      atom = /[^A-Za-z0-9\s]/.test(c) ? `%${c}` : c; i += 1;   // Lua %p: any punctuation, incl. _
    }
    const q = rx[i];
    if (q === '?' || q === '*' || q === '+') {
      out.push(atom + q); i += 1;
    } else if (q === '{') {
      const j = rx.indexOf('}', i);
      if (j < 0) return null;
      const m = /^(\d+)(,?)(\d*)$/.exec(rx.slice(i + 1, j));
      if (!m) return null;
      const a = Number(m[1]);
      let s = atom.repeat(a);
      if (m[2] === ',') {
        if (m[3] === '') s += `${atom}*`;
        else {
          const b = Number(m[3]);
          if (b < a) return null;
          s += `${atom}?`.repeat(b - a);
        }
      }
      out.push(s); i = j + 1;
    } else {
      out.push(atom);
    }
  }
  return out.join('');
}

const splitList = v => String(v ?? '').split(/[\s,]+/).filter(Boolean);
const isDigits = s => /^\d+$/.test(String(s ?? ''));

/** Error for one route, or null. Draft saves accept incomplete routes; Validate/Publish use this. */
export function routeError(route) {
  if (!route || typeof route !== 'object') return 'is not a route';
  const v = String(route.value ?? '').trim();
  switch (route.type) {
    case 'equals':
    case 'starts_with':
      if (!v) return 'needs a value';
      if (!/^[0-9*#]+$/.test(v)) return 'use digits 0–9, * or #';
      return null;
    case 'one_of': {
      const items = splitList(v);
      if (!items.length) return 'needs at least one value';
      if (items.some(x => !/^[0-9*#]+$/.test(x))) return 'values must be digits 0–9, * or #';
      return null;
    }
    case 'range': {
      const hi = String(route.value2 ?? '').trim();
      if (!v || !hi) return 'needs a from and a to value';
      if (!isDigits(v) || !isDigits(hi)) return 'range bounds must be whole numbers';
      if (Number(v) > Number(hi)) return 'from must not be larger than to';
      return null;
    }
    case 'length': {
      if (!v) return 'needs a number of digits';
      const k = Number(v);
      if (!Number.isInteger(k) || k < 1 || k > 20) return 'length must be 1–20';
      return null;
    }
    case 'pattern': {
      if (!v) return 'needs a pattern';
      try { new RegExp(v); } catch { return 'pattern does not compile'; }
      if (regexToLuaPattern(v) === null) return 'pattern uses unsupported syntax (groups or | are not supported)';
      return null;
    }
    default:
      return 'has an unknown type';
  }
}

/** Does the entry match this route? (JS twin of gather_route_matches.) */
export function routeMatches(route, d) {
  const v = String(route?.value ?? '');
  switch (route?.type) {
    case 'equals': return d === v;
    case 'one_of': return splitList(v).includes(d);
    case 'range': {
      if (!isDigits(d) || !isDigits(v) || !isDigits(route.value2)) return false;
      const x = Number(d);
      return x >= Number(v) && x <= Number(route.value2);
    }
    case 'starts_with': return v !== '' && d.startsWith(v);
    case 'length': return d.length === Number(v);
    case 'pattern': {
      if (regexToLuaPattern(v) === null) return false;
      try { return new RegExp(v).test(d); } catch { return false; }
    }
    default: return false;
  }
}

/** First route whose rule matches (connection is checked by the caller). */
export function firstMatchingRoute(routes, d) {
  return (routes || []).find(r => routeMatches(r, d)) || null;
}

/** Short label shown on the exit when the route has no custom name. */
export function routeLabel(route) {
  const name = String(route?.name ?? '').trim();
  if (name) return name;
  const v = String(route?.value ?? '').trim();
  switch (route?.type) {
    case 'equals': return v ? `= ${v}` : '= …';
    case 'one_of': {
      const items = splitList(v);
      return items.length > 2 ? `${items.slice(0, 2).join(', ')}, +${items.length - 2}` : (items.join(', ') || 'One of …');
    }
    case 'range': return `${v || '…'}–${String(route.value2 ?? '').trim() || '…'}`;
    case 'starts_with': return `${v || '…'}…`;
    case 'length': return v ? `${v} digits` : '… digits';
    case 'pattern': return 'Pattern';
    default: return 'Route';
  }
}

/**
 * Warnings for a route list: unreachable or overlapping rules (D-design B).
 * Returns [{ index, message }].
 */
export function routeWarnings(routes) {
  const out = [];
  const list = routes || [];
  list.forEach((r, i) => {
    if (routeError(r)) return;
    const earlier = list.slice(0, i).filter(e => !routeError(e));
    const label = routeLabel(r);
    const caughtBy = value => earlier.find(e => routeMatches(e, value));
    if (r.type === 'equals' || r.type === 'one_of') {
      const values = r.type === 'equals' ? [String(r.value).trim()] : splitList(r.value);
      const caught = values.map(v => [v, caughtBy(v)]).filter(([, e]) => e);
      if (caught.length === values.length) out.push({ index: i, message: `"${label}" can never match — "${routeLabel(caught[0][1])}" catches it first` });
      else for (const [v, e] of caught) out.push({ index: i, message: `${v} in "${label}" is caught first by "${routeLabel(e)}"` });
    } else if (r.type === 'range') {
      const lo = Number(r.value); const hi = Number(r.value2);
      for (const e of earlier.filter(x => x.type === 'range')) {
        const elo = Number(e.value); const ehi = Number(e.value2);
        if (elo <= lo && ehi >= hi) { out.push({ index: i, message: `"${label}" can never match — "${routeLabel(e)}" covers it` }); break; }
        if (elo <= hi && ehi >= lo) out.push({ index: i, message: `"${label}" overlaps "${routeLabel(e)}"; the earlier route wins` });
      }
    } else if (r.type === 'length') {
      const e = earlier.find(x => x.type === 'length' && Number(x.value) === Number(r.value));
      if (e) out.push({ index: i, message: `"${label}" can never match — "${routeLabel(e)}" catches it first` });
    } else if (r.type === 'starts_with') {
      const v = String(r.value).trim();
      const e = earlier.find(x => x.type === 'starts_with' && v.startsWith(String(x.value).trim()));
      if (e) out.push({ index: i, message: `"${label}" can never match — "${routeLabel(e)}" catches it first` });
    }
  });
  return out;
}
