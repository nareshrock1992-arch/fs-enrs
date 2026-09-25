// Presentation-only node styling: maps the registry's `category`/`type` to an
// enterprise visual identity — a SUBTLE tinted surface + a stronger category
// accent. This is purely how a node is DRAWN; it changes nothing about node
// semantics, ports, config, or execution. One reusable mapping, consumed by
// FlowNode, NodePalette and PropertyPanel — never duplicated per component.
//
// The IVR canvas is a fixed dark surface (#0d1117), so nodes are LIGHT tinted
// cards regardless of the app light/dark theme — this keeps categories legible
// on the canvas in both themes.
import {
  Play, MessageSquareText, Keyboard, GitBranch, CornerUpLeft, Megaphone,
  Siren, PhoneOff, Mic, Variable, PhoneForwarded, Webhook, Plug, BellRing,
  Split, Timer, Radio, Volume2, Circle,
} from 'lucide-react';

// ── Visual categories → colours ───────────────────────────────────────────────
// surface  : node body tint (very subtle)   surfaceHover/Sel : progressively stronger
// border   : resting border                  borderSel        : selected border (accent)
// accent   : icon + accent bar + ports
export const CATEGORY_VISUALS = {
  flow:        { accent: '#64748B', surface: '#F1F5F9', surfaceHover: '#E9EEF4', surfaceSel: '#E2E8F0', border: '#CBD5E1', borderSel: '#64748B' },
  input:       { accent: '#6366F1', surface: '#EEF2FF', surfaceHover: '#E7ECFF', surfaceSel: '#E0E7FF', border: '#C7D2FE', borderSel: '#6366F1' },
  audio:       { accent: '#8B5CF6', surface: '#F5F3FF', surfaceHover: '#EFEBFF', surfaceSel: '#EDE9FE', border: '#DDD6FE', borderSel: '#8B5CF6' },
  logic:       { accent: '#D97706', surface: '#FFFBEB', surfaceHover: '#FEF6D9', surfaceSel: '#FEF3C7', border: '#FDE68A', borderSel: '#D97706' },
  integration: { accent: '#0891B2', surface: '#ECFEFF', surfaceHover: '#DEFAFE', surfaceSel: '#CFFAFE', border: '#A5F3FC', borderSel: '#0891B2' },
  callControl: { accent: '#2563EB', surface: '#EFF6FF', surfaceHover: '#E4EEFF', surfaceSel: '#DBEAFE', border: '#BFDBFE', borderSel: '#2563EB' },
  termination: { accent: '#DC2626', surface: '#FEF2F2', surfaceHover: '#FDE8E8', surfaceSel: '#FEE2E2', border: '#FECACA', borderSel: '#DC2626' },
  emergency:   { accent: '#0D9488', surface: '#F0FDFA', surfaceHover: '#DEFAF3', surfaceSel: '#CCFBF1', border: '#99F6E4', borderSel: '#0D9488' },
  recording:   { accent: '#059669', surface: '#ECFDF5', surfaceHover: '#DEFBEC', surfaceSel: '#D1FAE5', border: '#A7F3D0', borderSel: '#059669' },
};
const DEFAULT_VISUAL = CATEGORY_VISUALS.flow;

// Fixed dark text for the light node cards (theme-independent — the card is
// always light because the canvas is always dark).
export const NODE_TEXT = { title: '#172033', summary: '#475569', muted: '#64748B' };

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
export function nodeStyle(cfg) {
  const v = CATEGORY_VISUALS[visualKey(cfg)] || DEFAULT_VISUAL;
  return { ...v, Icon: iconForType(cfg?.type), category: cfg?.category || '' };
}
