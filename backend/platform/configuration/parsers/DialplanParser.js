/**
 * DialplanParser — parses and serialises FreeSWITCH dialplan XML files.
 *
 * Converts XML ↔ a hierarchical object model (DialplanDoc).
 * Never performs I/O, never imports from provider/catalog layers.
 *
 * ── Object model ──────────────────────────────────────────────────────────────
 *
 * DialplanDoc {
 *   contextName:  string,
 *   contextAttrs: Record<string,string>,   // extra attributes on <context>
 *   nodes:        Node[],                  // ordered content of the context
 *   checksum:     string
 * }
 *
 * Node (discriminated union on .type):
 *   { type:'extension', id, name, continue, attrs, enabled, conditions }
 *   { type:'comment',   id, text }         — comment block between elements
 *   { type:'directive', id, raw  }         — X-PRE-PROCESS / passthrough
 *
 * Condition {
 *   id, field, expression, expressionCdata, expressionIsChild,
 *   break, attrs, enabled, actions, antiActions
 * }
 *
 * Action { id, application, data, enabled }
 *
 * ── Change operations (for applyChanges) ──────────────────────────────────────
 *
 * Context   : update_context
 * Extension : add_extension, update_extension, delete_extension, move_extension
 * Condition : add_condition, update_condition, delete_condition, move_condition
 * Action    : add_action, update_action, delete_action, move_action
 *             (all require extensionId + conditionId; move_action/add_action also need kind)
 * Other     : add_comment, delete_comment, add_directive, delete_directive
 *
 * ── Round-trip behaviour ──────────────────────────────────────────────────────
 *
 * Serialization generates clean canonical XML; whitespace differs from the
 * original but the semantics are fully preserved.
 * Comments between extensions are stored as 'comment' nodes and re-emitted.
 * Multi-line comment blocks (including commented-out extension fragments) are
 * preserved verbatim as their full text content.
 * Unknown top-level elements (X-PRE-PROCESS, etc.) are stored as 'directive'
 * nodes and re-emitted as-is.
 */

import crypto from 'crypto';
import { XMLParser } from 'fast-xml-parser';

// ── fast-xml-parser config ─────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes:     false,
  attributeNamePrefix:  '@_',
  textNodeName:         '#text',
  commentPropName:      '#comment',
  cdataPropName:        '__cdata',
  parseAttributeValue:  false,
  parseTagValue:        false,
  preserveOrder:        true,
  trimValues:           false,
  allowBooleanAttributes: false,
});

// ── ID generation ──────────────────────────────────────────────────────────────
// IDs are ephemeral — generated fresh on each parse, never written to XML.
// The UI uses them only within the lifetime of the current loaded document.

let _seq = 0;
const nextId = () => `n_${++_seq}`;

// ── Node accessors (preserveOrder format) ─────────────────────────────────────

function tagOf(node) {
  return Object.keys(node).find(k => k !== ':@') ?? null;
}

function attrsOf(node) {
  return node[':@'] ?? {};
}

function childrenOf(node) {
  const tag = tagOf(node);
  if (!tag) return [];
  const val = node[tag];
  return Array.isArray(val) ? val : [];
}

// Strip the '@_' prefix added by fast-xml-parser.
function stripPrefix(attrs) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    out[k.startsWith('@_') ? k.slice(2) : k] = v;
  }
  return out;
}

// ── Parse ──────────────────────────────────────────────────────────────────────

/**
 * Parse a FreeSWITCH dialplan XML file into a DialplanDoc.
 *
 * @param {string} rawContent
 * @param {object} [hints]
 * @param {string} [hints.contextName] — fallback context name used when the
 *   document is a fragment (no <context> wrapper). Callers should pass the
 *   context name derived from the provider ID (segment 2 of 'dialplan:ctx:frag').
 * @returns {DialplanDoc}
 */
export function parse(rawContent, hints = {}) {
  _seq = 0; // reset ID sequence per parse

  let tree;
  try {
    tree = xmlParser.parse(rawContent);
  } catch (err) {
    throw new Error(`DialplanParser: XML parse error — ${err.message}`);
  }

  const { contextName, contextAttrs, contextChildren, isFragment } =
    findContext(tree, hints);
  const nodes = buildNodes(contextChildren);

  return { contextName, contextAttrs, nodes, checksum: sha256(rawContent), isFragment };
}

/**
 * Locate the <context> element and return its name, attrs, children, and
 * whether the document is a fragment (no <context> wrapper).
 *
 * Supports four document layouts:
 *   (a) <?xml?> + <include><context name="…">…</context></include>   — standalone
 *   (b) <include><context name="…">…</context></include>              — standalone
 *   (c) bare <context name="…">…</context>                           — standalone
 *   (d) <include> with direct <extension> children (no <context>)     — fragment
 *   (e) bare <extension> elements at root                             — fragment
 *
 * Fragment layouts occur for files included via `default/*.xml` directives.
 * Their context name is derived from hints.contextName (supplied by the provider
 * from its own ID) rather than from the document itself.
 */
function findContext(tree, hints = {}) {
  // ── Layouts (a), (b), (c): explicit <context> element ──────────────────────
  for (const node of tree) {
    const tag = tagOf(node);

    if (tag === 'include') {
      for (const child of childrenOf(node)) {
        if (tagOf(child) === 'context') {
          return { ...extractContextNode(child), isFragment: false };
        }
      }
    }

    if (tag === 'context') {
      return { ...extractContextNode(node), isFragment: false };
    }
  }

  // ── Layout (d): <include> whose direct children are <extension> elements ───
  // Occurs when a fragment author adds an <include> wrapper around bare extensions.
  for (const node of tree) {
    if (tagOf(node) === 'include') {
      const includeChildren = childrenOf(node);
      if (includeChildren.some(c => tagOf(c) === 'extension')) {
        return {
          contextName:     hints.contextName ?? '',
          contextAttrs:    {},
          contextChildren: includeChildren,
          isFragment:      true,
        };
      }
    }
  }

  // ── Layout (e): bare <extension> elements at document root ─────────────────
  // Most common fragment form: file contains only <extension> blocks with no
  // outer wrapper. FreeSWITCH includes these via `dialplan/default/*.xml`.
  if (tree.some(n => tagOf(n) === 'extension')) {
    return {
      contextName:     hints.contextName ?? '',
      contextAttrs:    {},
      contextChildren: tree,
      isFragment:      true,
    };
  }

  throw new Error(
    'DialplanParser: no <context> element found. ' +
    'Expected <include><context name="...">…</context></include>.'
  );
}

function extractContextNode(node) {
  const rawAttrs   = attrsOf(node);
  const contextName = rawAttrs['@_name'] ?? 'default';
  const contextAttrs = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (k !== '@_name') contextAttrs[k.slice(2)] = v;
  }
  return { contextName, contextAttrs, contextChildren: childrenOf(node) };
}

// ── Build node list from context children ──────────────────────────────────────

function buildNodes(children) {
  const nodes         = [];
  const pendingTexts  = []; // accumulates consecutive comment strings

  const flushComments = () => {
    if (pendingTexts.length === 0) return;
    nodes.push({ type: 'comment', id: nextId(), text: pendingTexts.join('') });
    pendingTexts.length = 0;
  };

  for (const child of children) {
    const tag = tagOf(child);

    // Whitespace text nodes — skip
    if (tag === '#text') continue;

    // Comment nodes — accumulate consecutive ones
    if (tag === '#comment') {
      // fast-xml-parser stores the comment text as the direct value of '#comment'
      const raw = child['#comment'];
      const text = typeof raw === 'string' ? raw : (Array.isArray(raw) ? raw.map(c => c['#text'] ?? '').join('') : '');
      pendingTexts.push(text);
      continue;
    }

    // Any non-comment, non-text node: flush accumulated comments first
    flushComments();

    if (tag === 'extension') {
      nodes.push(buildExtension(child));
      continue;
    }

    // Everything else (X-PRE-PROCESS, unknown elements) → directive
    nodes.push({ type: 'directive', id: nextId(), raw: rebuildElement(child) });
  }

  flushComments();
  return nodes;
}

// ── Build Extension ────────────────────────────────────────────────────────────

function buildExtension(node) {
  const rawAttrs = attrsOf(node);
  const name     = rawAttrs['@_name']     ?? '';
  const contAttr = rawAttrs['@_continue'] ?? null;

  // Collect any non-standard attributes (e.g. hint="")
  const extraAttrs = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (k !== '@_name' && k !== '@_continue') extraAttrs[k.slice(2)] = v;
  }

  const conditions = [];
  for (const child of childrenOf(node)) {
    if (tagOf(child) === 'condition') conditions.push(buildCondition(child));
  }

  return {
    type:       'extension',
    id:         nextId(),
    name,
    continue:   contAttr,
    attrs:      extraAttrs,
    enabled:    true,
    conditions,
  };
}

// ── Build Condition ────────────────────────────────────────────────────────────

function buildCondition(node) {
  const rawAttrs     = attrsOf(node);
  const field        = rawAttrs['@_field']      ?? null;
  const expressionAttr = rawAttrs['@_expression'] ?? null;
  const breakAttr    = rawAttrs['@_break']      ?? null;

  // Time-based and other extra attributes (wday, mday, hour, mon, etc.)
  const extraAttrs = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (!['@_field', '@_expression', '@_break'].includes(k)) {
      extraAttrs[k.slice(2)] = v;
    }
  }

  const actions    = [];
  const antiActions = [];
  let expressionFromChild = null;
  let expressionCdata     = false;

  for (const child of childrenOf(node)) {
    const ct = tagOf(child);

    if (ct === '#text') continue;

    if (ct === 'expression') {
      // <expression> child: may contain plain text or CDATA
      for (const exprChild of childrenOf(child)) {
        const et = tagOf(exprChild);
        if (et === '__cdata') {
          expressionFromChild = exprChild['__cdata'] ?? '';
          expressionCdata     = true;
        } else if (et === '#text') {
          expressionFromChild = exprChild['#text'] ?? '';
        }
      }
      // Handle case where the text is the direct value
      if (expressionFromChild === null) {
        const direct = child['expression'];
        if (typeof direct === 'string') expressionFromChild = direct;
      }
      continue;
    }

    if (ct === 'action')      { actions.push(buildAction(child));      continue; }
    if (ct === 'anti-action') { antiActions.push(buildAction(child));  continue; }
  }

  return {
    id:               nextId(),
    field,
    expression:       expressionFromChild ?? expressionAttr,
    expressionCdata,
    expressionIsChild: expressionFromChild !== null,
    break:            breakAttr,
    attrs:            extraAttrs,
    enabled:          true,
    actions,
    antiActions,
  };
}

// ── Build Action / Anti-Action ─────────────────────────────────────────────────

function buildAction(node) {
  const rawAttrs = attrsOf(node);
  return {
    id:          nextId(),
    application: rawAttrs['@_application'] ?? '',
    data:        rawAttrs['@_data'] ?? null,
    enabled:     true,
  };
}

// ── Rebuild unknown elements as raw XML strings ────────────────────────────────

function rebuildElement(node) {
  const tag   = tagOf(node);
  if (!tag) return '';
  const rawAttrs = attrsOf(node);
  const attrs    = stripPrefix(rawAttrs);
  const attrStr  = buildAttrString(attrs);
  const children = childrenOf(node);
  if (children.length === 0) {
    return `<${tag}${attrStr}/>`;
  }
  // For elements with content, preserve text children
  const inner = children
    .map(c => {
      const t = tagOf(c);
      if (t === '#text') return String(c['#text'] ?? '');
      return rebuildElement(c);
    })
    .join('');
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

// ── Serialize ──────────────────────────────────────────────────────────────────

/**
 * Serialize a DialplanDoc back to a FreeSWITCH-compatible XML string.
 * Generates clean canonical XML; does not round-trip original whitespace.
 *
 * Standalone docs  (doc.isFragment !== true) → full <include><context>…</context></include>
 * Fragment docs    (doc.isFragment === true)  → bare <extension> elements only,
 *   matching the format FreeSWITCH expects for files included via `default/*.xml`.
 *
 * @param {object} doc — DialplanDoc
 * @returns {string}
 */
export function serialize(doc) {
  if (doc.isFragment) {
    return _serializeFragment(doc);
  }

  const lines = [];
  lines.push('<include>');

  const ctxAttrStr = buildAttrString({ name: doc.contextName, ...doc.contextAttrs });
  lines.push(`  <context${ctxAttrStr}>`);
  lines.push('');

  for (const node of doc.nodes) {
    switch (node.type) {
      case 'comment':
        emitComment(lines, node, '    ');
        break;
      case 'directive':
        lines.push(`    ${node.raw}`);
        break;
      case 'extension':
        emitExtension(lines, node, '    ');
        break;
    }
    lines.push('');
  }

  lines.push('  </context>');
  lines.push('</include>');

  return lines.join('\n');
}

/**
 * Serialize a fragment DialplanDoc — bare extension/comment/directive nodes
 * with no <include><context> wrapper.
 */
function _serializeFragment(doc) {
  const lines = [];

  for (const node of doc.nodes) {
    switch (node.type) {
      case 'comment':
        emitComment(lines, node, '');
        break;
      case 'directive':
        lines.push(node.raw);
        break;
      case 'extension':
        emitExtension(lines, node, '');
        break;
    }
    lines.push('');
  }

  // Trim trailing blank lines, then ensure a single trailing newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function emitComment(lines, node, indent) {
  const text = node.text ?? '';
  // Single-line comment
  if (!text.includes('\n')) {
    lines.push(`${indent}<!--${text}-->`);
    return;
  }
  // Multi-line comment — preserve inner lines with indent
  const inner = text.split('\n');
  lines.push(`${indent}<!--`);
  for (const ln of inner) {
    lines.push(`${indent}${ln}`);
  }
  lines.push(`${indent}-->`);
}

function emitExtension(lines, node, indent) {
  if (!node.enabled) {
    // Wrap entire extension in a comment block
    const inner = [];
    buildExtensionLines(inner, node, '');
    lines.push(`${indent}<!--`);
    for (const ln of inner) lines.push(`${indent}${ln}`);
    lines.push(`${indent}-->`);
    return;
  }
  buildExtensionLines(lines, node, indent);
}

function buildExtensionLines(lines, node, indent) {
  const attrs = { name: node.name };
  if (node.continue) attrs.continue = node.continue;
  Object.assign(attrs, node.attrs ?? {});

  if (node.conditions.length === 0) {
    lines.push(`${indent}<extension${buildAttrString(attrs)}/>`);
    return;
  }

  lines.push(`${indent}<extension${buildAttrString(attrs)}>`);

  for (const cond of node.conditions) {
    emitCondition(lines, cond, indent + '  ');
  }

  lines.push(`${indent}</extension>`);
}

function emitCondition(lines, cond, indent) {
  const attrs = {};
  if (cond.field !== null && cond.field !== undefined) attrs.field = cond.field;
  if (!cond.expressionIsChild && cond.expression !== null && cond.expression !== undefined) {
    attrs.expression = cond.expression;
  }
  if (cond.break !== null && cond.break !== undefined) attrs.break = cond.break;
  Object.assign(attrs, cond.attrs ?? {});

  const hasChildren = cond.expressionIsChild ||
    (cond.actions?.length  ?? 0) > 0 ||
    (cond.antiActions?.length ?? 0) > 0;

  if (!hasChildren) {
    lines.push(`${indent}<condition${buildAttrString(attrs)}/>`);
    return;
  }

  lines.push(`${indent}<condition${buildAttrString(attrs)}>`);

  if (cond.expressionIsChild) {
    if (cond.expressionCdata) {
      lines.push(`${indent}  <expression><![CDATA[${cond.expression ?? ''}]]></expression>`);
    } else {
      lines.push(`${indent}  <expression>${escapeXml(cond.expression ?? '')}</expression>`);
    }
  }

  for (const action of (cond.actions ?? [])) {
    emitAction(lines, action, indent + '  ', 'action');
  }

  for (const aa of (cond.antiActions ?? [])) {
    emitAction(lines, aa, indent + '  ', 'anti-action');
  }

  lines.push(`${indent}</condition>`);
}

function emitAction(lines, action, indent, tagName) {
  const attrs = { application: action.application };
  if (action.data !== null && action.data !== undefined) attrs.data = action.data;
  const line = `${indent}<${tagName}${buildAttrString(attrs)}/>`;

  if (!action.enabled) {
    lines.push(`${indent}<!--${line.trim()}-->`);
  } else {
    lines.push(line);
  }
}

// ── applyChanges ───────────────────────────────────────────────────────────────

/**
 * Apply an ordered list of change operations to a DialplanDoc.
 * Returns a new document — input is never mutated.
 *
 * @param {object} doc      — DialplanDoc from parse()
 * @param {Array}  changes  — array of change operation objects
 * @returns {object}        — new DialplanDoc
 */
export function applyChanges(doc, changes) {
  let result = deepClone(doc);
  for (const change of changes) {
    result = _applyOne(result, change);
  }
  return result;
}

function _applyOne(doc, ch) {
  switch (ch.op) {

    // ── Context ────────────────────────────────────────────────────────────────
    case 'update_context':
      return { ...doc, ...(ch.patch ?? {}) };

    // ── Extensions ────────────────────────────────────────────────────────────
    case 'add_extension': {
      const ext = { type: 'extension', id: nextId(), ...ch.extension };
      if (!ch.beforeId) return { ...doc, nodes: [...doc.nodes, ext] };
      const idx = doc.nodes.findIndex(n => n.id === ch.beforeId);
      if (idx < 0) return { ...doc, nodes: [...doc.nodes, ext] };
      const nodes = [...doc.nodes];
      nodes.splice(idx, 0, ext);
      return { ...doc, nodes };
    }

    case 'update_extension':
      return {
        ...doc,
        nodes: doc.nodes.map(n =>
          n.type === 'extension' && n.id === ch.id ? { ...n, ...(ch.patch ?? {}) } : n
        ),
      };

    case 'delete_extension':
      return { ...doc, nodes: doc.nodes.filter(n => !(n.type === 'extension' && n.id === ch.id)) };

    case 'move_extension': {
      const ext  = doc.nodes.find(n => n.type === 'extension' && n.id === ch.id);
      if (!ext) return doc;
      const base = doc.nodes.filter(n => !(n.type === 'extension' && n.id === ch.id));
      if (!ch.beforeId) return { ...doc, nodes: [...base, ext] };
      const idx  = base.findIndex(n => n.id === ch.beforeId);
      if (idx < 0) return { ...doc, nodes: [...base, ext] };
      const nodes = [...base];
      nodes.splice(idx, 0, ext);
      return { ...doc, nodes };
    }

    // ── Conditions ────────────────────────────────────────────────────────────
    case 'add_condition':
      return {
        ...doc,
        nodes: doc.nodes.map(n => {
          if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
          const cond       = { id: nextId(), ...ch.condition };
          const conditions = [...n.conditions];
          if (ch.atIndex !== undefined) conditions.splice(ch.atIndex, 0, cond);
          else                          conditions.push(cond);
          return { ...n, conditions };
        }),
      };

    case 'update_condition':
      return {
        ...doc,
        nodes: doc.nodes.map(n => {
          if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
          return {
            ...n,
            conditions: n.conditions.map(c =>
              c.id === ch.id ? { ...c, ...(ch.patch ?? {}) } : c
            ),
          };
        }),
      };

    case 'delete_condition':
      return {
        ...doc,
        nodes: doc.nodes.map(n => {
          if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
          return { ...n, conditions: n.conditions.filter(c => c.id !== ch.id) };
        }),
      };

    case 'move_condition':
      return {
        ...doc,
        nodes: doc.nodes.map(n => {
          if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
          const cond = n.conditions.find(c => c.id === ch.id);
          if (!cond) return n;
          const arr  = n.conditions.filter(c => c.id !== ch.id);
          arr.splice(Math.min(ch.toIndex ?? arr.length, arr.length), 0, cond);
          return { ...n, conditions: arr };
        }),
      };

    // ── Actions ───────────────────────────────────────────────────────────────
    case 'add_action': {
      const action = {
        id:          ch._tempId ?? nextId(),
        application: ch.application ?? '',
        data:        ch.data ?? null,
        enabled:     true,
      };
      return _walkCondition(doc, ch, 'actions', arr => {
        if (ch.atIndex !== undefined) {
          const a = [...arr];
          a.splice(ch.atIndex, 0, action);
          return a;
        }
        return [...arr, action];
      });
    }

    case 'update_action':
      return _walkCondition(doc, ch, 'actions', arr =>
        arr.map(a => a.id === ch.id ? { ...a, ..._pickDefined(ch, ['application', 'data', 'enabled']) } : a)
      );

    case 'delete_action':
      return _walkCondition(doc, ch, 'actions', arr => arr.filter(a => a.id !== ch.id));

    case 'move_action':
      return _withAction(doc, ch, (arr) => {
        const item  = arr.find(a => a.id === ch.id);
        if (!item) return arr;
        const base  = arr.filter(a => a.id !== ch.id);
        base.splice(Math.min(ch.toIndex ?? base.length, base.length), 0, item);
        return base;
      });

    // ── Anti-actions ──────────────────────────────────────────────────────────
    case 'add_anti_action': {
      const aa = {
        id:          ch._tempId ?? nextId(),
        application: ch.application ?? '',
        data:        ch.data ?? null,
        enabled:     true,
      };
      return _walkCondition(doc, ch, 'antiActions', arr => {
        if (ch.atIndex !== undefined) {
          const a = [...arr];
          a.splice(ch.atIndex, 0, aa);
          return a;
        }
        return [...arr, aa];
      });
    }

    case 'update_anti_action':
      return _walkCondition(doc, ch, 'antiActions', arr =>
        arr.map(a => a.id === ch.id ? { ...a, ..._pickDefined(ch, ['application', 'data', 'enabled']) } : a)
      );

    case 'delete_anti_action':
      return _walkCondition(doc, ch, 'antiActions', arr => arr.filter(a => a.id !== ch.id));

    // ── Comments / Directives ─────────────────────────────────────────────────
    case 'add_comment': {
      const comment = { type: 'comment', id: nextId(), text: ch.text ?? '' };
      return _insertNode(doc, comment, ch.beforeId);
    }
    case 'delete_comment':
      return { ...doc, nodes: doc.nodes.filter(n => !(n.type === 'comment' && n.id === ch.id)) };

    case 'add_directive': {
      const dir = { type: 'directive', id: nextId(), raw: ch.raw ?? '' };
      return _insertNode(doc, dir, ch.beforeId);
    }
    case 'delete_directive':
      return { ...doc, nodes: doc.nodes.filter(n => !(n.type === 'directive' && n.id === ch.id)) };

    default:
      throw new Error(`DialplanParser.applyChanges: unknown op '${ch.op}'`);
  }
}

/**
 * Navigate to a condition's named array (`actions` or `antiActions`) and apply
 * a transform to it. Used by add/update/delete ops for both action types.
 * The `key` parameter is supplied by the caller — no `ch.kind` discriminator needed.
 */
function _walkCondition(doc, ch, key, transform) {
  return {
    ...doc,
    nodes: doc.nodes.map(n => {
      if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
      return {
        ...n,
        conditions: n.conditions.map(c => {
          if (c.id !== ch.conditionId) return c;
          return { ...c, [key]: transform(c[key] ?? []) };
        }),
      };
    }),
  };
}

/** Copy only keys that are present and not undefined from `src` into a new object. */
function _pickDefined(src, keys) {
  const out = {};
  for (const k of keys) {
    if (k in src && src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

/** Shared helper: mutate the actions or antiActions array of a specific condition. */
function _withAction(doc, ch, transform) {
  const key = ch.kind === 'anti-action' ? 'antiActions' : 'actions';
  return {
    ...doc,
    nodes: doc.nodes.map(n => {
      if (n.type !== 'extension' || n.id !== ch.extensionId) return n;
      return {
        ...n,
        conditions: n.conditions.map(c => {
          if (c.id !== ch.conditionId) return c;
          const newAction = ch.op === 'add_action'
            ? { id: nextId(), enabled: true, ...ch.action }
            : null;
          return {
            ...c,
            [key]: transform(c[key] ?? [], newAction),
          };
        }),
      };
    }),
  };
}

/** Insert a node before `beforeId`, or at the end if not found. */
function _insertNode(doc, node, beforeId) {
  if (!beforeId) return { ...doc, nodes: [...doc.nodes, node] };
  const idx = doc.nodes.findIndex(n => n.id === beforeId);
  if (idx < 0) return { ...doc, nodes: [...doc.nodes, node] };
  const nodes = [...doc.nodes];
  nodes.splice(idx, 0, node);
  return { ...doc, nodes };
}

// ── diff ───────────────────────────────────────────────────────────────────────

/**
 * Generate a human-readable diff between two raw content strings.
 * @param {string} oldRaw
 * @param {string} newRaw
 * @param {object} [hints] — same hints accepted by parse() (e.g. { contextName })
 * @returns {string}
 */
export function diff(oldRaw, newRaw, hints = {}) {
  if (oldRaw === newRaw) return '(no dialplan changes)';

  const oldDoc = parse(oldRaw, hints);
  const newDoc = parse(newRaw, hints);
  const lines  = [];

  if (oldDoc.contextName !== newDoc.contextName) {
    lines.push(`~ Context renamed: "${oldDoc.contextName}" → "${newDoc.contextName}"`);
  }

  const oldExts = oldDoc.nodes.filter(n => n.type === 'extension');
  const newExts = newDoc.nodes.filter(n => n.type === 'extension');

  const oldNames = oldExts.map(e => e.name);
  const newNames = newExts.map(e => e.name);
  const oldSet   = new Set(oldNames);
  const newSet   = new Set(newNames);

  for (const name of oldNames) {
    if (!newSet.has(name)) lines.push(`- Removed extension: "${name}"`);
  }
  for (const name of newNames) {
    if (!oldSet.has(name)) lines.push(`+ Added extension: "${name}"`);
  }

  const oldByName = new Map(oldExts.map(e => [e.name, e]));
  const newByName = new Map(newExts.map(e => [e.name, e]));

  for (const [name, newExt] of newByName) {
    const oldExt = oldByName.get(name);
    if (!oldExt) continue;
    const diffLines = _diffExtension(oldExt, newExt);
    for (const dl of diffLines) lines.push(`  [${name}] ${dl}`);
  }

  // Check for reordering among unchanged names
  const commonInOrder = newNames.filter(n => oldSet.has(n));
  const commonOldOrder = oldNames.filter(n => newSet.has(n));
  if (JSON.stringify(commonInOrder) !== JSON.stringify(commonOldOrder)) {
    lines.push('~ Extension order changed');
  }

  return lines.length > 0 ? lines.join('\n') : '(no structural changes)';
}

function _diffExtension(oldExt, newExt) {
  const lines = [];
  if (oldExt.enabled !== newExt.enabled) {
    lines.push(newExt.enabled ? 'enabled' : 'disabled');
  }
  if (oldExt.continue !== newExt.continue) {
    lines.push(`continue: ${oldExt.continue ?? 'false'} → ${newExt.continue ?? 'false'}`);
  }
  const oc = oldExt.conditions.length;
  const nc = newExt.conditions.length;
  if (oc !== nc) {
    lines.push(`conditions: ${oc} → ${nc}`);
  } else {
    // Count total action changes
    let actionChanges = 0;
    for (let i = 0; i < oc; i++) {
      const old = oldExt.conditions[i];
      const nw  = newExt.conditions[i];
      if (old.expression !== nw.expression) lines.push(`condition[${i}] expression changed`);
      if (old.field !== nw.field)           lines.push(`condition[${i}] field changed`);
      if (old.actions.length !== nw.actions.length || old.antiActions.length !== nw.antiActions.length) {
        actionChanges++;
      }
    }
    if (actionChanges > 0) lines.push(`${actionChanges} condition(s) have action changes`);
  }
  return lines;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildAttrString(attrs) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) {
      parts.push(`${k}="${escapeXmlAttr(String(v))}"`);
    }
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function escapeXmlAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
