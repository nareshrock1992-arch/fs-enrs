/**
 * __configDiag.js  — single-pass Config Center rendering pipeline diagnostic.
 *
 * Covers every layer from API response to painted DOM element:
 *   L1  API entries count + sample shapes
 *   L2  filtered count + active filter state
 *   L3  grouped category names + per-category entry counts
 *   L4  accordion toggle — proves click handler fires + Set state
 *   L5  ConfigCard() invocation — proves React calls the component
 *   L6  DOM presence of rendered cards + accordion bodies
 *   L7  CSS chain (display/visibility/opacity/height/overflow/z-index)
 *       on first card and its six nearest ancestors
 *   L8  React error boundary catch (wired via ConfigDiagBoundary)
 *
 * DELETE this file and every import of it once the root cause is found.
 */

// ── Global JS error trap (catches ReferenceError, TypeError, etc.) ────────────

if (typeof window !== 'undefined' && !window.__cfgDiagErrorsWired) {
  window.__cfgDiagErrorsWired = true;

  window.addEventListener('error', (e) => {
    console.error(
      '[DIAG ERR] JS error during render:',
      e.message,
      '\n  source:', e.filename,
      '\n  line/col:', e.lineno, ':', e.colno,
      '\n  stack:', e.error?.stack,
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    console.error('[DIAG ERR] unhandled rejection:', e.reason);
  });
}

// ── Phase loggers ─────────────────────────────────────────────────────────────

/**
 * L1 — call in ConfigPage useEffect([entries]) after the API loads.
 */
export function diagL1Entries(entries) {
  const sample = entries.slice(0, 3).map(e => ({
    key: e.key,
    cat: (e.metadata ?? e).category ?? '(none)',
    vis: (e.metadata ?? e).visibility ?? '(none)',
    hasMetadata: 'metadata' in e,
  }));

  console.group('%c[DIAG L1] API → entries', 'color:#0ea5e9;font-weight:bold');
  console.log('total entries:', entries.length);
  console.log('first 3 entries:', sample);
  if (entries.length === 0) console.warn('⚠ entries is empty — API returned no data or load() failed');
  console.groupEnd();
}

/**
 * L2 — call in ConfigPage useEffect([filtered, visibilityLevel, category]).
 */
export function diagL2Filtered(filtered, visibilityLevel, category) {
  const byCategory = {};
  filtered.forEach(e => {
    const c = (e.metadata ?? e).category || '(none)';
    byCategory[c] = (byCategory[c] ?? 0) + 1;
  });

  console.group('%c[DIAG L2] filtered entries', 'color:#0ea5e9;font-weight:bold');
  console.log('count:', filtered.length, '| visibilityLevel:', visibilityLevel, '| category filter:', category);
  console.log('by category:', byCategory);
  if (filtered.length === 0) console.warn('⚠ filtered is empty — isVisible() or category/search filter removed all entries');
  console.groupEnd();
}

/**
 * L3 — call in ConfigSection right after groupByHierarchy + Object.keys.
 */
export function diagL3Grouped(grouped, categories) {
  const catCounts = {};
  for (const cat of categories) {
    const groups = grouped[cat];
    const groupKeys = Object.keys(groups);
    const entryCount = Object.values(groups).flat().length;
    catCounts[cat] = { groups: groupKeys, entries: entryCount };
  }

  console.group('%c[DIAG L3] grouped hierarchy', 'color:#0ea5e9;font-weight:bold');
  console.log('category count:', categories.length, '| names:', categories);
  console.table(catCounts);
  if (categories.length === 0) console.warn('⚠ no categories — groupByHierarchy returned empty object');
  if (categories.length === 1) console.info('ℹ single category → ConfigSection renders FLAT LIST (no accordion)');
  console.groupEnd();
}

/**
 * L4 — call inside toggleCategory after computing next Set.
 * Pass the category string and the new expanded array.
 */
export function diagL4Toggle(cat, expandedArr) {
  console.group('%c[DIAG L4] accordion toggle', 'color:#f59e0b;font-weight:bold');
  console.log('toggled category:', cat);
  console.log('expanded set is now:', expandedArr);
  if (expandedArr.length === 0) console.log('  → category was CLOSED (was open, now closed)');
  else console.log('  → categories now OPEN:', expandedArr);
  console.groupEnd();
}

/**
 * L5 — call at the very top of ConfigCard() function body.
 * Only logs the first invocation to avoid flooding; use the count below.
 */
let _cardCount = 0;
export function diagL5CardInvoked(key) {
  _cardCount++;
  if (_cardCount === 1) {
    console.log('%c[DIAG L5] ✓ ConfigCard() invoked — first key:', 'color:#22c55e;font-weight:bold', key);
  }
  if (_cardCount === 10) {
    console.log('[DIAG L5] (suppressing further card logs — at least 10 cards invoked)');
  }
}

/**
 * L5 summary — call from a useEffect inside ConfigSection after expanded changes.
 * Prints total card invocation count since last reset.
 */
export function diagL5Summary() {
  console.log('%c[DIAG L5] ConfigCard() total invocations this render:', 'color:#22c55e', _cardCount);
  _cardCount = 0; // reset for next expand cycle
}

/**
 * L6 + L7 — DOM inspection.
 * Call from a useEffect inside ConfigSection that fires when `expanded` changes.
 * Uses double-rAF so React has committed the DOM before we query.
 */
export function diagL6DomAndCss() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    console.group('%c[DIAG L6] DOM inspection', 'color:#a855f7;font-weight:bold');

    const section = document.querySelector('[data-cfg-section]');
    const bodies  = document.querySelectorAll('[data-cfg-accordion-body]');
    const cards   = document.querySelectorAll('[data-cfg-card]');

    console.log('[data-cfg-section] found:', section ? '✓' : '✗ MISSING');
    console.log('[data-cfg-accordion-body] count:', bodies.length);
    console.log('[data-cfg-card] count:', cards.length);

    if (bodies.length > 0 && cards.length === 0) {
      console.warn('⚠ accordion body is in the DOM but NO cards rendered inside it');
      const firstBody = bodies[0];
      console.log('  body.children.length:', firstBody.children.length);
      console.log('  body.innerHTML (first 300 chars):', firstBody.innerHTML.substring(0, 300));
    }

    if (bodies.length > 0) {
      console.group('[DIAG L6b] first accordion body computed style');
      _logStyle(bodies[0]);
      console.groupEnd();
    }

    if (cards.length > 0) {
      console.group('%c[DIAG L7] CSS ancestry chain — first card → 6 ancestors', 'color:#a855f7');
      _logChain(cards[0], 6);
      console.groupEnd();
    } else {
      // No cards at all — walk up from accordion body looking for overflow traps
      if (bodies.length > 0) {
        console.group('[DIAG L7] CSS ancestry of accordion body (no cards found)');
        _logChain(bodies[0], 8);
        console.groupEnd();
      }
    }

    console.groupEnd(); // [DIAG L6]
  }));
}

function _logStyle(el) {
  if (!el) return;
  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  console.log({
    tag:        el.tagName,
    class:      (el.className || '').substring(0, 80),
    display:    cs.display,
    visibility: cs.visibility,
    opacity:    cs.opacity,
    height:     cs.height,
    maxHeight:  cs.maxHeight,
    overflow:   cs.overflow,
    overflowY:  cs.overflowY,
    clipPath:   cs.clipPath,
    zIndex:     cs.zIndex,
    position:   cs.position,
    transform:  cs.transform !== 'none' ? cs.transform : undefined,
    'rect.height':  rect.height,
    'rect.top':     rect.top,
    'rect.bottom':  rect.bottom,
    'rect.inView':  rect.top < window.innerHeight && rect.bottom > 0,
  });
}

function _logChain(el, depth) {
  if (!el || el === document.body || depth <= 0) return;
  const indent = '  '.repeat(Math.max(0, 6 - depth));
  console.log(`${indent}▸ <${el.tagName.toLowerCase()}> [depth ${6 - depth + 1}]`);
  _logStyle(el);
  _logChain(el.parentElement, depth - 1);
}

/**
 * L8 — wire to an error boundary's componentDidCatch.
 */
export function diagL8BoundaryCatch(error, info) {
  console.group('%c[DIAG L8] ⛔ React error boundary caught', 'color:#ef4444;font-weight:bold');
  console.error('error:', error);
  console.error('component stack:', info?.componentStack);
  console.groupEnd();
}
