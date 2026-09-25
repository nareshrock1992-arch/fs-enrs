// Single source of truth for node geometry, shared by FlowNode (rendering) and
// FlowCanvas (edge/port anchor math). Keeping both in lockstep guarantees edges
// stay attached to the exact centre of each rendered port dot.
//
// Layout (px, node-local, top-left origin):
//   [ HEADER_H ........... icon + type ]
//   [ SUMMARY_H .......... reserved summary area ]
//   [ PORT_ROW_H ......... one output row per port (dot centred) ]
//   ...
//   [ BOTTOM_PAD ]

export const NODE_WIDTH = 212;
export const HEADER_H   = 40;
export const SUMMARY_H  = 30;
export const PORT_ROW_H = 28;
export const BOTTOM_PAD = 8;
export const PORT_TOP   = HEADER_H + SUMMARY_H;   // 70 — top of the first port row
export const PORT_INSET = 14;                     // dot centre, px left of the node's right edge

// Vertical centre of the i-th output port (node-local y).
export function portCenterY(index) {
  return PORT_TOP + Math.max(0, index) * PORT_ROW_H + PORT_ROW_H / 2;
}

// Total node height for a given port count (nodes grow with their outputs).
export function nodeHeight(portCount) {
  const n = Math.max(0, portCount || 0);
  return PORT_TOP + (n > 0 ? n * PORT_ROW_H + BOTTOM_PAD : BOTTOM_PAD);
}

// Back-compat default (nodes with a single output). Real height is per-node.
export const NODE_HEIGHT = nodeHeight(1);
