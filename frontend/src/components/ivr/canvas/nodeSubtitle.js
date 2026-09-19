// Pure subtitle-composition logic for a flow node's canvas card.
//
// Cosmetic only — this never affects call execution or code generation. It is
// extracted from FlowNode.jsx (no React imports) so the display rules can be
// unit-tested directly.
//
// Approved display rules:
//   - Primary line   = the node type's summaryTemplate rendered from node
//                      config (e.g. Transfer "→ 7352", Condition "x == y").
//   - Secondary line = the optional node.description, shown BENEATH the summary
//                      so both stay visible together.
//   - Exception: Go To Node's summary is a raw target node id (meaningless to
//     read), so a non-empty description REPLACES it (no primary line).

// Render a node type's summaryTemplate against the node's config values.
// Missing/empty referenced fields render as "?" (unchanged legacy behavior).
//
// `resolvers` optionally maps a field to a human-readable name. cfg.summaryResolve
// declares which resolver a field uses, e.g. { ens_configuration_id: 'ens_config',
// target_node_id: 'node', operator: 'operator' }. When a resolver returns a value
// it replaces the raw id/token; otherwise the raw value is shown (graceful
// fallback if names aren't loaded yet). This never affects the stored config.
export function renderSummaryTemplate(node, cfg, resolvers = {}) {
  const tmpl = cfg?.summaryTemplate;
  if (!tmpl) return null;
  const resolveMap = cfg?.summaryResolve || {};
  return tmpl.replace(/\$\{(\w+)\}/g, (_, key) => {
    const v = node?.[key];
    if (v === undefined || v === null || v === '') return '?';
    const resolverName = resolveMap[key];
    if (resolverName && typeof resolvers[resolverName] === 'function') {
      const resolved = resolvers[resolverName](v);
      if (resolved !== undefined && resolved !== null && resolved !== '') {
        return String(resolved).slice(0, 30);
      }
    }
    return String(v).slice(0, 24);
  });
}

// Compute the two canvas subtitle lines for a node.
// Returns { primary: string|null, secondary: string|null }.
export function nodeSubtitleLines(node, cfg, resolvers = {}) {
  const desc = typeof node?.description === 'string' ? node.description.trim() : '';
  const summary = renderSummaryTemplate(node, cfg, resolvers);

  // Go To Node: the summary is a raw target node id; a description replaces it.
  if (node?.type === 'goto' && desc) {
    return { primary: desc, secondary: null };
  }

  return {
    primary:   summary || null,
    secondary: desc || null,
  };
}
