// Presentation-only node styling: maps the registry's `category`/`type` to an
// enterprise visual identity — a SUBTLE tinted surface + a stronger category
// accent. This is purely how a node is DRAWN; it changes nothing about node
// semantics, ports, config, or execution. One reusable mapping, consumed by
// FlowNode, NodePalette and PropertyPanel — never duplicated per component.
//
// Phase 2a: the canvas and cards now FOLLOW the app's light/dark theme (tokens
// in index.css: --canvas-bg, --node-surface, --node-border, --text-*). Cards are
// clean, theme-neutral surfaces; the category identity is carried by the accent
// (left bar + icon chip + selected border), not by tinting the whole card.
import {
  Play, MessageSquareText, Keyboard, GitBranch, CornerUpLeft, Megaphone,
  Siren, PhoneOff, Mic, Variable, PhoneForwarded, Webhook, Plug, BellRing,
  Split, Timer, Radio, Volume2, Circle,
} from 'lucide-react';

// ── Visual categories → accent colour ─────────────────────────────────────────
// Only the ACCENT is category-specific now (left bar, icon chip, selected
// border). Card surfaces/borders are neutral, theme-aware tokens (see NEUTRAL
// below) so cards read as one clean family rather than a tinted rainbow.
export const CATEGORY_VISUALS = {
  flow:        { accent: '#64748B' },
  input:       { accent: '#6366F1' },
  audio:       { accent: '#8B5CF6' },
  logic:       { accent: '#D97706' },
  integration: { accent: '#0891B2' },
  callControl: { accent: '#2563EB' },
  termination: { accent: '#DC2626' },
  emergency:   { accent: '#0D9488' },
  recording:   { accent: '#059669' },
};
const DEFAULT_VISUAL = CATEGORY_VISUALS.flow;

// Neutral, theme-aware card surfaces/border (resolved from CSS vars at render).
// Same for every category — the accent carries the category identity.
const NEUTRAL = {
  surface:      'rgb(var(--node-surface))',
  surfaceHover: 'rgb(var(--node-surface-hover))',
  surfaceSel:   'rgb(var(--node-surface-sel))',
  border:       'rgb(var(--node-border))',
};

// Card text follows the theme now (readable on white in light mode, on the
// raised dark card in dark mode).
export const NODE_TEXT = {
  title:   'rgb(var(--text-primary))',
  summary: 'rgb(var(--text-secondary))',
  muted:   'rgb(var(--text-muted))',
};

// Per-type Lucide icon (enterprise icon system, replacing emoji glyphs).
const TYPE_ICON = {
  play: Play, say: MessageSquareText, gather: Keyboard, condition: GitBranch,
  goto: CornerUpLeft, ens: Megaphone, ers: Siren, hangup: PhoneOff,
  record_message: Mic, set_variable: Variable, transfer: PhoneForwarded,
  webhook: Webhook, rest_api: Plug, ers_ring_all: BellRing,
  ers_overflow_check: Split, ers_overflow_wait: Timer,
  ens_blast_record: Radio, ens_playback: Volume2,
};

// Per-type → visual category. Gives the enterprise granularity the registry's
// coarse `category` lacks (e.g. Flow → transfer/hangup/goto split into
// callControl/termination/flow). Falls back to the registry category below.
const TYPE_VISUAL = {
  gather: 'input',
  condition: 'logic', set_variable: 'logic',
  play: 'audio', say: 'audio',
  goto: 'flow',
  transfer: 'callControl',
  hangup: 'termination',
  webhook: 'integration', rest_api: 'integration',
  record_message: 'recording',
  ens: 'emergency', ers: 'emergency', ers_ring_all: 'emergency',
  ers_overflow_check: 'emergency', ers_overflow_wait: 'emergency',
  ens_blast_record: 'emergency', ens_playback: 'emergency',
};
// Registry category → visual category (fallback for unknown types).
const CATEGORY_VISUAL = {
  Audio: 'audio', Input: 'input', Flow: 'flow',
  Emergency: 'emergency', Integrations: 'integration', Recording: 'recording',
};

export function visualKey(cfg) {
  return TYPE_VISUAL[cfg?.type] || CATEGORY_VISUAL[cfg?.category] || 'flow';
}
export function iconForType(type) {
  return TYPE_ICON[type] || Circle;
}
export function accentForCategory(category) {
  return (CATEGORY_VISUALS[CATEGORY_VISUAL[category]] || DEFAULT_VISUAL).accent;
}

// Full presentational descriptor for a node type config (from the registry).
// accent = category colour; borderSel = accent (selection keeps category
// identity); surfaces/border = neutral theme tokens.
export function nodeStyle(cfg) {
  const accent = (CATEGORY_VISUALS[visualKey(cfg)] || DEFAULT_VISUAL).accent;
  return {
    ...NEUTRAL,
    accent,
    borderSel: accent,
    Icon: iconForType(cfg?.type),
    category: cfg?.category || '',
  };
}
