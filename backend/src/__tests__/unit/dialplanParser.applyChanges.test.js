/**
 * dialplanParser.applyChanges — comprehensive op protocol tests.
 *
 * Every test verifies the Gen2 flat-field protocol that the frontend uses.
 * This file is the regression guard for bugs DP-001, DP-002, DP-003, DP-004:
 *   DP-001 — update_extension silent no-op (ch.patch never sent)
 *   DP-002 — update_condition silent no-op (ch.patch never sent)
 *   DP-003 — add_extension creates nameless extension (ch.extension never sent)
 *   DP-004 — update_context used wrong field name (name vs contextName)
 */

import { describe, it, expect } from 'vitest';
import { parse, applyChanges } from '../../../platform/configuration/parsers/DialplanParser.js';

// ── Fixture ────────────────────────────────────────────────────────────────────

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<include>
  <context name="default">
    <extension name="echo_test">
      <condition field="destination_number" expression="^9196$">
        <action application="answer"/>
        <action application="echo"/>
        <anti-action application="hangup" data="USER_BUSY"/>
      </condition>
    </extension>
    <extension name="bridge_out">
      <condition field="destination_number" expression="^9197$">
        <action application="bridge" data="sofia/gateway/gw1/15551234567"/>
      </condition>
    </extension>
  </context>
</include>`;

function freshDoc() {
  return parse(XML);
}

function ext(doc, name) {
  return doc.nodes.find(n => n.type === 'extension' && n.name === name);
}

function extById(doc, id) {
  return doc.nodes.find(n => n.type === 'extension' && n.id === id);
}

// ── update_context ─────────────────────────────────────────────────────────────

describe('update_context', () => {
  it('changes contextName via top-level contextName field (DP-004 regression)', () => {
    const doc = freshDoc();
    const result = applyChanges(doc, [{ op: 'update_context', contextName: 'sales' }]);
    expect(result.contextName).toBe('sales');
  });

  it('does not mutate the source document', () => {
    const doc = freshDoc();
    applyChanges(doc, [{ op: 'update_context', contextName: 'sales' }]);
    expect(doc.contextName).toBe('default');
  });

  it('ignores unknown fields without error', () => {
    const doc = freshDoc();
    expect(() => applyChanges(doc, [{ op: 'update_context', unknown: 'x' }])).not.toThrow();
  });
});

// ── add_extension ──────────────────────────────────────────────────────────────

describe('add_extension — Gen2 protocol (DP-003 regression)', () => {
  it('appends a new extension with the provided name', () => {
    const doc = freshDoc();
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'new_ext' }]);
    const added = result.nodes.find(n => n.type === 'extension' && n.name === 'new_ext');
    expect(added).toBeDefined();
  });

  it('new extension has the correct name — never empty or undefined (DP-003)', () => {
    const doc    = freshDoc();
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'my_route' }]);
    const added  = result.nodes.find(n => n.type === 'extension' && n.name === 'my_route');
    expect(added.name).toBe('my_route');
  });

  it('uses _tempId as the node id when supplied', () => {
    const doc    = freshDoc();
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'x', _tempId: 'temp_ext_123' }]);
    const added  = extById(result, 'temp_ext_123');
    expect(added).toBeDefined();
    expect(added.name).toBe('x');
  });

  it('defaults enabled to true', () => {
    const doc    = freshDoc();
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'x' }]);
    const added  = result.nodes.find(n => n.name === 'x');
    expect(added.enabled).toBe(true);
  });

  it('defaults conditions to empty array', () => {
    const doc    = freshDoc();
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'x' }]);
    const added  = result.nodes.find(n => n.name === 'x');
    expect(Array.isArray(added.conditions)).toBe(true);
    expect(added.conditions.length).toBe(0);
  });

  it('increases the node count by 1', () => {
    const doc    = freshDoc();
    const before = doc.nodes.length;
    const result = applyChanges(doc, [{ op: 'add_extension', name: 'x' }]);
    expect(result.nodes.length).toBe(before + 1);
  });

  it('does not mutate the source document', () => {
    const doc    = freshDoc();
    const before = doc.nodes.length;
    applyChanges(doc, [{ op: 'add_extension', name: 'x' }]);
    expect(doc.nodes.length).toBe(before);
  });
});

// ── update_extension ───────────────────────────────────────────────────────────

describe('update_extension — Gen2 protocol (DP-001 regression)', () => {
  it('renames an extension via top-level name field', () => {
    const doc  = freshDoc();
    const id   = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'update_extension', id, name: 'renamed' }]);
    expect(ext(result, 'renamed')).toBeDefined();
    expect(ext(result, 'echo_test')).toBeUndefined();
  });

  it('name update is NOT a silent no-op (DP-001)', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'update_extension', id, name: 'verified_rename' }]);
    // If this were still a no-op the name would remain 'echo_test'
    const found = result.nodes.find(n => n.name === 'verified_rename');
    expect(found).toBeDefined();
  });

  it('sets enabled to false', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'update_extension', id, enabled: false }]);
    expect(extById(result, id).enabled).toBe(false);
  });

  it('sets continue to true', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'update_extension', id, continue: 'true' }]);
    expect(extById(result, id).continue).toBe('true');
  });

  it('other extensions are unaffected', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'update_extension', id, name: 'renamed' }]);
    expect(ext(result, 'bridge_out')).toBeDefined();
  });

  it('does not mutate the source document', () => {
    const doc  = freshDoc();
    const id   = ext(doc, 'echo_test').id;
    applyChanges(doc, [{ op: 'update_extension', id, name: 'mutated' }]);
    expect(ext(doc, 'echo_test')).toBeDefined();
  });

  it('unknown id is a no-op (does not throw)', () => {
    const doc = freshDoc();
    expect(() => applyChanges(doc, [{ op: 'update_extension', id: 'nonexistent', name: 'x' }])).not.toThrow();
  });
});

// ── delete_extension ───────────────────────────────────────────────────────────

describe('delete_extension', () => {
  it('removes the named extension', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'delete_extension', id }]);
    expect(ext(result, 'echo_test')).toBeUndefined();
  });

  it('decreases node count by 1', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const before = doc.nodes.length;
    const result = applyChanges(doc, [{ op: 'delete_extension', id }]);
    expect(result.nodes.length).toBe(before - 1);
  });

  it('other extensions survive', () => {
    const doc    = freshDoc();
    const id     = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'delete_extension', id }]);
    expect(ext(result, 'bridge_out')).toBeDefined();
  });
});

// ── add_condition ──────────────────────────────────────────────────────────────

describe('add_condition — Gen2 protocol (DP-008 regression)', () => {
  it('appends a condition with the provided field and expression', () => {
    const doc     = freshDoc();
    const extNode = ext(doc, 'echo_test');
    const before  = extNode.conditions.length;
    const result  = applyChanges(doc, [{
      op: 'add_condition', extensionId: extNode.id,
      field: 'caller_id_number', expression: '^1234$', _tempId: 'tmp_cond_1',
    }]);
    const conditions = ext(result, 'echo_test').conditions;
    expect(conditions.length).toBe(before + 1);
    expect(conditions.at(-1).field).toBe('caller_id_number');
    expect(conditions.at(-1).expression).toBe('^1234$');
  });

  it('uses _tempId as condition id (DP-008 — not a nameless/idless condition)', () => {
    const doc     = freshDoc();
    const extNode = ext(doc, 'echo_test');
    const result  = applyChanges(doc, [{
      op: 'add_condition', extensionId: extNode.id,
      field: 'destination_number', _tempId: 'cond_tmp_99',
    }]);
    const added = ext(result, 'echo_test').conditions.find(c => c.id === 'cond_tmp_99');
    expect(added).toBeDefined();
    expect(added.field).toBe('destination_number');
  });

  it('defaults to empty actions and antiActions', () => {
    const doc     = freshDoc();
    const extNode = ext(doc, 'echo_test');
    const result  = applyChanges(doc, [{
      op: 'add_condition', extensionId: extNode.id, field: 'f',
    }]);
    const added = ext(result, 'echo_test').conditions.at(-1);
    expect(Array.isArray(added.actions)).toBe(true);
    expect(Array.isArray(added.antiActions)).toBe(true);
  });

  it('inserts at atIndex when provided', () => {
    const doc     = freshDoc();
    const extNode = ext(doc, 'echo_test');
    const result  = applyChanges(doc, [{
      op: 'add_condition', extensionId: extNode.id,
      field: 'inserted', expression: '^0$', atIndex: 0,
    }]);
    expect(ext(result, 'echo_test').conditions[0].field).toBe('inserted');
  });

  it('does not mutate the source document', () => {
    const doc     = freshDoc();
    const extNode = ext(doc, 'echo_test');
    const before  = extNode.conditions.length;
    applyChanges(doc, [{ op: 'add_condition', extensionId: extNode.id, field: 'x' }]);
    expect(ext(doc, 'echo_test').conditions.length).toBe(before);
  });
});

// ── update_condition ───────────────────────────────────────────────────────────

describe('update_condition — Gen2 protocol (DP-002 regression)', () => {
  it('updates the field attribute via top-level field field', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_condition', id: condId, extensionId: extNode.id, field: 'caller_id_number',
    }]);
    const cond = ext(result, 'echo_test').conditions[0];
    expect(cond.field).toBe('caller_id_number');
  });

  it('field update is NOT a silent no-op (DP-002)', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_condition', id: condId, extensionId: extNode.id, expression: '^1234$',
    }]);
    // If still a no-op it would remain '^9196$'
    expect(ext(result, 'echo_test').conditions[0].expression).toBe('^1234$');
  });

  it('updates the expression', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_condition', id: condId, extensionId: extNode.id, expression: '^9999$',
    }]);
    expect(ext(result, 'echo_test').conditions[0].expression).toBe('^9999$');
  });

  it('updates the break attribute', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_condition', id: condId, extensionId: extNode.id, break: 'on-true',
    }]);
    expect(ext(result, 'echo_test').conditions[0].break).toBe('on-true');
  });

  it('disables a condition', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_condition', id: condId, extensionId: extNode.id, enabled: false,
    }]);
    expect(ext(result, 'echo_test').conditions[0].enabled).toBe(false);
  });

  it('does not mutate the source document', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    applyChanges(doc, [{ op: 'update_condition', id: condId, extensionId: extNode.id, expression: '^mutated$' }]);
    expect(ext(doc, 'echo_test').conditions[0].expression).toBe('^9196$');
  });
});

// ── add_action ─────────────────────────────────────────────────────────────────

describe('add_action', () => {
  it('appends a new action to the condition', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const before   = extNode.conditions[0].actions.length;
    const result   = applyChanges(doc, [{
      op: 'add_action', extensionId: extNode.id, conditionId: condId,
      application: 'log', data: 'INFO hello', _tempId: 'tmp_a_1',
    }]);
    const actions = ext(result, 'echo_test').conditions[0].actions;
    expect(actions.length).toBe(before + 1);
    expect(actions.at(-1).application).toBe('log');
  });

  it('uses _tempId as action id when supplied', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'add_action', extensionId: extNode.id, conditionId: condId,
      application: 'log', _tempId: 'my_temp_id',
    }]);
    const added = ext(result, 'echo_test').conditions[0].actions.find(a => a.id === 'my_temp_id');
    expect(added).toBeDefined();
  });

  it('defaults enabled to true', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const result   = applyChanges(doc, [{
      op: 'add_action', extensionId: extNode.id, conditionId: condId, application: 'log',
    }]);
    expect(ext(result, 'echo_test').conditions[0].actions.at(-1).enabled).toBe(true);
  });
});

// ── update_action ──────────────────────────────────────────────────────────────

describe('update_action', () => {
  it('updates application on an existing action', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const actionId = extNode.conditions[0].actions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_action', id: actionId, extensionId: extNode.id, conditionId: condId,
      application: 'sleep',
    }]);
    const updated = ext(result, 'echo_test').conditions[0].actions.find(a => a.id === actionId);
    expect(updated.application).toBe('sleep');
  });

  it('updates data', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const actionId = extNode.conditions[0].actions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_action', id: actionId, extensionId: extNode.id, conditionId: condId,
      data: '1000',
    }]);
    expect(ext(result, 'echo_test').conditions[0].actions.find(a => a.id === actionId).data).toBe('1000');
  });

  it('disables an action', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const actionId = extNode.conditions[0].actions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_action', id: actionId, extensionId: extNode.id, conditionId: condId,
      enabled: false,
    }]);
    expect(ext(result, 'echo_test').conditions[0].actions.find(a => a.id === actionId).enabled).toBe(false);
  });
});

// ── delete_action ──────────────────────────────────────────────────────────────

describe('delete_action', () => {
  it('removes the specified action', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const actionId = extNode.conditions[0].actions[0].id;
    const before   = extNode.conditions[0].actions.length;
    const result   = applyChanges(doc, [{
      op: 'delete_action', id: actionId, extensionId: extNode.id, conditionId: condId,
    }]);
    const actions = ext(result, 'echo_test').conditions[0].actions;
    expect(actions.length).toBe(before - 1);
    expect(actions.find(a => a.id === actionId)).toBeUndefined();
  });
});

// ── add_anti_action ────────────────────────────────────────────────────────────

describe('add_anti_action', () => {
  it('appends a new anti-action to the condition', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const before   = extNode.conditions[0].antiActions.length;
    const result   = applyChanges(doc, [{
      op: 'add_anti_action', extensionId: extNode.id, conditionId: condId,
      application: 'answer', _tempId: 'tmp_aa_1',
    }]);
    expect(ext(result, 'echo_test').conditions[0].antiActions.length).toBe(before + 1);
  });

  it('does not add to the actions array', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const actionCount = extNode.conditions[0].actions.length;
    const result   = applyChanges(doc, [{
      op: 'add_anti_action', extensionId: extNode.id, conditionId: condId, application: 'answer',
    }]);
    expect(ext(result, 'echo_test').conditions[0].actions.length).toBe(actionCount);
  });
});

// ── update_anti_action ─────────────────────────────────────────────────────────

describe('update_anti_action', () => {
  it('updates the application on an existing anti-action', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const aaId     = extNode.conditions[0].antiActions[0].id;
    const result   = applyChanges(doc, [{
      op: 'update_anti_action', id: aaId, extensionId: extNode.id, conditionId: condId,
      application: 'reject',
    }]);
    const updated = ext(result, 'echo_test').conditions[0].antiActions.find(a => a.id === aaId);
    expect(updated.application).toBe('reject');
  });

  it('does not affect the actions array', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const aaId     = extNode.conditions[0].antiActions[0].id;
    const actionCount = extNode.conditions[0].actions.length;
    const result   = applyChanges(doc, [{
      op: 'update_anti_action', id: aaId, extensionId: extNode.id, conditionId: condId,
      application: 'reject',
    }]);
    expect(ext(result, 'echo_test').conditions[0].actions.length).toBe(actionCount);
  });
});

// ── delete_anti_action ─────────────────────────────────────────────────────────

describe('delete_anti_action', () => {
  it('removes the specified anti-action', () => {
    const doc      = freshDoc();
    const extNode  = ext(doc, 'echo_test');
    const condId   = extNode.conditions[0].id;
    const aaId     = extNode.conditions[0].antiActions[0].id;
    const before   = extNode.conditions[0].antiActions.length;
    const result   = applyChanges(doc, [{
      op: 'delete_anti_action', id: aaId, extensionId: extNode.id, conditionId: condId,
    }]);
    expect(ext(result, 'echo_test').conditions[0].antiActions.length).toBe(before - 1);
    expect(ext(result, 'echo_test').conditions[0].antiActions.find(a => a.id === aaId)).toBeUndefined();
  });
});

// ── move_extension ─────────────────────────────────────────────────────────────

describe('move_extension', () => {
  it('moves an extension before a sibling using beforeId', () => {
    const doc       = freshDoc();
    const echoId    = ext(doc, 'echo_test').id;
    const bridgeId  = ext(doc, 'bridge_out').id;
    // Move bridge_out before echo_test
    const result    = applyChanges(doc, [{
      op: 'move_extension', id: bridgeId, beforeId: echoId,
    }]);
    const names = result.nodes.filter(n => n.type === 'extension').map(n => n.name);
    expect(names[0]).toBe('bridge_out');
    expect(names[1]).toBe('echo_test');
  });

  it('moves extension to end when beforeId absent', () => {
    const doc    = freshDoc();
    const echoId = ext(doc, 'echo_test').id;
    const result = applyChanges(doc, [{ op: 'move_extension', id: echoId }]);
    const exts   = result.nodes.filter(n => n.type === 'extension');
    expect(exts.at(-1).name).toBe('echo_test');
  });
});

// ── unknown op ─────────────────────────────────────────────────────────────────

describe('unknown op', () => {
  it('throws for an unknown op name', () => {
    const doc = freshDoc();
    expect(() => applyChanges(doc, [{ op: 'explode_everything' }])).toThrow(/unknown op/i);
  });
});

// ── op ordering / multiple ops ─────────────────────────────────────────────────

describe('multiple ops applied in order', () => {
  it('add then rename: both ops take effect', () => {
    const doc  = freshDoc();
    const result = applyChanges(doc, [
      { op: 'add_extension', name: 'temp_ext', _tempId: 'tmp_999' },
      { op: 'update_extension', id: 'tmp_999', name: 'final_name' },
    ]);
    expect(result.nodes.find(n => n.name === 'final_name')).toBeDefined();
    expect(result.nodes.find(n => n.name === 'temp_ext')).toBeUndefined();
  });

  it('add then delete: extension is absent from result', () => {
    const doc  = freshDoc();
    const result = applyChanges(doc, [
      { op: 'add_extension', name: 'ephemeral', _tempId: 'tmp_del' },
      { op: 'delete_extension', id: 'tmp_del' },
    ]);
    expect(result.nodes.find(n => n.name === 'ephemeral')).toBeUndefined();
  });

  it('applying zero ops returns a new object equal to the input', () => {
    const doc    = freshDoc();
    const result = applyChanges(doc, []);
    expect(result).not.toBe(doc);
    expect(result.contextName).toBe(doc.contextName);
    expect(result.nodes.length).toBe(doc.nodes.length);
  });
});
