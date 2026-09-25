// Presentation-only node styling: maps the registry's existing `category` and
// `type` fields to an enterprise accent colour + a Lucide icon. This is purely
// how a node is DRAWN — it reads registry metadata and changes nothing about
// node semantics, ports, config, or execution. The backend node registry stays
// the source of truth; this file never adds/removes/renames a node or branch.
import {
  Play, MessageSquareText, Keyboard, GitBranch, CornerUpLeft, Megaphone,
  Siren, PhoneOff, Mic, Variable, PhoneForwarded, Webhook, Plug, BellRing,
  Split, Timer, Radio, Volume2, Circle,
} from 'lucide-react';

// Restrained, category-based accents. Used as an ACCENT only (header bar, icon,
// category dot, selected ring) — the node body itself stays neutral/light.
export const CATEGORY_ACCENT = {
  Audio:        '#7C3AED', // purple
  Input:        '#4F46E5', // indigo
  Flow:         '#64748B', // slate / blue-gray
  Emergency:    '#DC2626', // controlled operational red
  Integrations: '#0D9488', // teal
  Recording:    '#D97706', // amber
};
const DEFAULT_ACCENT = '#64748B';

// Per-type Lucide icon (enterprise icon system, replacing emoji glyphs).
const TYPE_ICON = {
  play: Play, say: MessageSquareText, gather: Keyboard, condition: GitBranch,
  goto: CornerUpLeft, ens: Megaphone, ers: Siren, hangup: PhoneOff,
  record_message: Mic, set_variable: Variable, transfer: PhoneForwarded,
  webhook: Webhook, rest_api: Plug, ers_ring_all: BellRing,
  ers_overflow_check: Split, ers_overflow_wait: Timer,
  ens_blast_record: Radio, ens_playback: Volume2,
};

export function accentForCategory(category) {
  return CATEGORY_ACCENT[category] || DEFAULT_ACCENT;
}

export function iconForType(type) {
  return TYPE_ICON[type] || Circle;
}

// Full presentational descriptor for a node type config (from the registry).
export function nodeStyle(cfg) {
  return {
    accent: accentForCategory(cfg?.category),
    Icon:   iconForType(cfg?.type),
    category: cfg?.category || '',
  };
}
