import { useReducer, useCallback, useEffect, useRef } from 'react';
import { api } from '../api/client.js';

// ── ID generation ─────────────────────────────────────────────────────────────

let _seq = 0;
function genId() {
  return `node_${Date.now()}_${++_seq}`;
}

// ── Default fields per node type ──────────────────────────────────────────────

export const NODE_DEFAULTS = {
  play:           { audio_url: '/media/', next: '' },
  say:            { text: '', language: 'en-US', next: '' },
  gather:         { max_digits: 4, timeout_seconds: 10, terminators: '#', variable_name: 'gather_result', branches: { _default: '', timeout: '', invalid: '' } },
  goto:           { target_node_id: '' },
  ens:            { ens_config_var: 'ens_configuration_id', recording_file_var: 'recorded_file_path', next: '' },
  ers:            { ers_configuration_id: '' },
  hangup:         {},
  condition:      { variable: 'gather_result', operator: '==', expected_value: '', true_node: '', false_node: '' },
  record_message: { variable_name: 'recorded_file_path', max_seconds: 60, silence_threshold: 500, silence_hits: 3, prompt_text: 'Please record your message after the tone. Press pound when done.', next: '' },
  set_variable:   { variable: '', value: '', next: '' },
  transfer:       { destination: '', dialplan: 'XML', context: 'default' },
};

// ── Derive edges from node fields ─────────────────────────────────────────────
// Edges are not stored explicitly — they are computed from node connections.

export function deriveEdges(nodes) {
  const edges = [];
  for (const [id, node] of Object.entries(nodes)) {
    if (node.next) {
      edges.push({ id: `${id}__next`, from: id, fromPort: 'next', to: node.next });
    }
    if (node.target_node_id) {
      edges.push({ id: `${id}__goto`, from: id, fromPort: 'goto', to: node.target_node_id });
    }
    if (node.true_node) {
      edges.push({ id: `${id}__true`, from: id, fromPort: 'true', to: node.true_node });
    }
    if (node.false_node) {
      edges.push({ id: `${id}__false`, from: id, fromPort: 'false', to: node.false_node });
    }
    if (node.branches) {
      for (const [key, target] of Object.entries(node.branches)) {
        if (target) {
          edges.push({ id: `${id}__${key}`, from: id, fromPort: key, to: target });
        }
      }
    }
  }
  return edges;
}

// ── Serialise graph for API (strip layout positions) ─────────────────────────

export function serialiseGraph(nodes, entryNodeId) {
  const apiNodes = {};
  for (const [id, node] of Object.entries(nodes)) {
    // eslint-disable-next-line no-unused-vars
    const { x, y, id: _id, ...rest } = node;
    apiNodes[id] = rest;
  }
  return { entry_node_id: entryNodeId, nodes: apiNodes };
}

// ── Deserialise API graph → canvas nodes (add positions) ─────────────────────

export function deserialiseGraph(apiGraph) {
  if (!apiGraph?.nodes) return { nodes: {}, entryNodeId: '' };

  const layout = apiGraph._layout || {};
  const nodes  = {};
  let col = 0;

  for (const [id, node] of Object.entries(apiGraph.nodes)) {
    const pos = layout[id] || { x: 80 + (col % 4) * 200, y: 80 + Math.floor(col / 4) * 160 };
    nodes[id] = { id, ...node, x: pos.x, y: pos.y };
    col++;
  }

  return { nodes, entryNodeId: apiGraph.entry_node_id || '' };
}

// ── Reducer ───────────────────────────────────────────────────────────────────

const INIT = {
  nodes:       {},
  entryNodeId: '',
  selected:    null,
  dirty:       false,
  saving:      false,
  errors:      {},   // { [nodeId]: string[] }
  warnings:    [],
  flowMeta:    null, // { flow_uuid, name, latest_version, bound_numbers, ... }
};

function reducer(state, action) {
  switch (action.type) {

    case 'SEED': {
      const { nodes, entryNodeId } = deserialiseGraph(action.flow.graph);
      return {
        ...INIT,
        nodes,
        entryNodeId,
        flowMeta: action.flow,
      };
    }

    case 'ADD_NODE': {
      const id = genId();
      return {
        ...state,
        nodes: {
          ...state.nodes,
          [id]: {
            id,
            type: action.nodeType,
            x: action.x,
            y: action.y,
            ...NODE_DEFAULTS[action.nodeType],
          },
        },
        // Auto-set entry if first node
        entryNodeId: state.entryNodeId || id,
        selected: id,
        dirty: true,
      };
    }

    case 'UPDATE_NODE': {
      const node = state.nodes[action.id];
      if (!node) return state;
      return {
        ...state,
        nodes: { ...state.nodes, [action.id]: { ...node, ...action.patch } },
        dirty: true,
      };
    }

    case 'MOVE_NODE': {
      const node = state.nodes[action.id];
      if (!node) return state;
      return {
        ...state,
        nodes: { ...state.nodes, [action.id]: { ...node, x: action.x, y: action.y } },
        dirty: true,
      };
    }

    case 'DELETE_NODE': {
      const { [action.id]: _removed, ...remaining } = state.nodes;

      // Remove all references to this node from other nodes
      const cleaned = {};
      for (const [nid, node] of Object.entries(remaining)) {
        const patched = { ...node };
        if (patched.next === action.id)           patched.next = '';
        if (patched.target_node_id === action.id) patched.target_node_id = '';
        if (patched.true_node  === action.id)     patched.true_node  = '';
        if (patched.false_node === action.id)     patched.false_node = '';
        if (patched.branches) {
          patched.branches = { ...patched.branches };
          for (const [k, v] of Object.entries(patched.branches)) {
            if (v === action.id) patched.branches[k] = '';
          }
        }
        cleaned[nid] = patched;
      }

      return {
        ...state,
        nodes:       cleaned,
        entryNodeId: state.entryNodeId === action.id ? '' : state.entryNodeId,
        selected:    state.selected === action.id ? null : state.selected,
        dirty:       true,
      };
    }

    case 'CONNECT': {
      const node = state.nodes[action.from];
      if (!node) return state;
      let patched = { ...node };

      if (action.fromPort === 'next') {
        patched.next = action.to;
      } else if (action.fromPort === 'goto') {
        patched.target_node_id = action.to;
      } else if (action.fromPort === 'true') {
        patched.true_node = action.to;
      } else if (action.fromPort === 'false') {
        patched.false_node = action.to;
      } else {
        // branch key
        patched.branches = { ...patched.branches, [action.fromPort]: action.to };
      }

      return {
        ...state,
        nodes: { ...state.nodes, [action.from]: patched },
        dirty: true,
      };
    }

    case 'DISCONNECT': {
      const node = state.nodes[action.from];
      if (!node) return state;
      let patched = { ...node };

      if (action.fromPort === 'next') {
        patched.next = '';
      } else if (action.fromPort === 'goto') {
        patched.target_node_id = '';
      } else if (action.fromPort === 'true') {
        patched.true_node = '';
      } else if (action.fromPort === 'false') {
        patched.false_node = '';
      } else {
        patched.branches = { ...patched.branches, [action.fromPort]: '' };
      }

      return {
        ...state,
        nodes: { ...state.nodes, [action.from]: patched },
        dirty: true,
      };
    }

    case 'SET_SELECTED':
      return { ...state, selected: action.id };

    case 'SET_ENTRY':
      return { ...state, entryNodeId: action.id, dirty: true };

    case 'SET_ERRORS':
      return { ...state, errors: action.errors || {}, warnings: action.warnings || [] };

    case 'MARK_SAVING':
      return { ...state, saving: true };

    case 'MARK_SAVED':
      return { ...state, saving: false, dirty: false };

    case 'MARK_SAVE_ERROR':
      return { ...state, saving: false };

    case 'UPDATE_META':
      return { ...state, flowMeta: { ...state.flowMeta, ...action.patch } };

    default:
      return state;
  }
}

// ── useIvrGraph hook ──────────────────────────────────────────────────────────

export function useIvrGraph(flowUuid) {
  const [state, dispatch] = useReducer(reducer, INIT);
  const saveTimer = useRef(null);
  const stateRef  = useRef(state);
  stateRef.current = state;

  // Load flow on mount
  useEffect(() => {
    if (!flowUuid) return;
    api.ivr.get(flowUuid).then(({ flow }) => {
      dispatch({ type: 'SEED', flow });
    }).catch(console.error);
  }, [flowUuid]);

  // Auto-save draft on dirty (debounced 800ms)
  useEffect(() => {
    if (!state.dirty || state.saving) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);

    saveTimer.current = setTimeout(async () => {
      const s = stateRef.current;
      if (!s.dirty || !s.flowMeta?.flow_uuid) return;
      dispatch({ type: 'MARK_SAVING' });
      try {
        const graph = serialiseGraph(s.nodes, s.entryNodeId);
        // Store layout positions in _layout key (stripped by backend Zod, ignored)
        const layout = {};
        for (const [id, node] of Object.entries(s.nodes)) {
          layout[id] = { x: node.x, y: node.y };
        }
        graph._layout = layout;
        await api.ivr.update(s.flowMeta.flow_uuid, { graph });
        dispatch({ type: 'MARK_SAVED' });
      } catch (e) {
        console.error('[ivr] auto-save failed', e);
        dispatch({ type: 'MARK_SAVE_ERROR' });
      }
    }, 800);

    return () => clearTimeout(saveTimer.current);
  }, [state.dirty, state.saving]);

  const addNode    = useCallback((nodeType, x, y) => dispatch({ type: 'ADD_NODE', nodeType, x, y }), []);
  const updateNode = useCallback((id, patch) => dispatch({ type: 'UPDATE_NODE', id, patch }), []);
  const moveNode   = useCallback((id, x, y) => dispatch({ type: 'MOVE_NODE', id, x, y }), []);
  const deleteNode = useCallback((id) => dispatch({ type: 'DELETE_NODE', id }), []);
  const connect    = useCallback((from, fromPort, to) => dispatch({ type: 'CONNECT', from, fromPort, to }), []);
  const disconnect = useCallback((from, fromPort) => dispatch({ type: 'DISCONNECT', from, fromPort }), []);
  const setSelected = useCallback((id) => dispatch({ type: 'SET_SELECTED', id }), []);
  const setEntry   = useCallback((id) => dispatch({ type: 'SET_ENTRY', id }), []);
  const updateMeta = useCallback((patch) => dispatch({ type: 'UPDATE_META', patch }), []);

  const validate = useCallback(async () => {
    const s = stateRef.current;
    if (!s.flowMeta?.flow_uuid) return;
    try {
      const result = await api.ivr.validate(s.flowMeta.flow_uuid);
      // Map errors to node IDs where possible
      const errorMap = {};
      for (const err of result.errors || []) {
        const match = err.match(/^node ([^\s:]+)/);
        const nodeId = match?.[1];
        if (nodeId && s.nodes[nodeId]) {
          errorMap[nodeId] = [...(errorMap[nodeId] || []), err];
        } else {
          errorMap['__global'] = [...(errorMap['__global'] || []), err];
        }
      }
      dispatch({ type: 'SET_ERRORS', errors: errorMap, warnings: result.warnings || [] });
      return result;
    } catch (e) {
      console.error('[ivr] validate failed', e);
    }
  }, []);

  const edges = deriveEdges(state.nodes);

  return {
    ...state,
    edges,
    dispatch,
    addNode,
    updateNode,
    moveNode,
    deleteNode,
    connect,
    disconnect,
    setSelected,
    setEntry,
    updateMeta,
    validate,
  };
}
