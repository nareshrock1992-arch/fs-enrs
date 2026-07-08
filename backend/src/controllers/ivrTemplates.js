/**
 * Built-in IVR flow templates.
 *
 * Templates are instantiated via POST /ivr/templates/:id/create,
 * which inserts a new ivr_flows draft and returns the flow UUID
 * so the frontend can immediately navigate to the designer.
 */

import { query } from '../db/pool.js';
import { v4 as uuidv4 } from 'uuid';

// ── Template definitions ───────────────────────────────────────────────────────
//
// node IDs are kept short for readability.  The executor doesn't care —
// it follows the edges, not the IDs.

const TEMPLATES = {
  ens_basic: {
    name:        'ENS Alert Flow (Template)',
    description: 'Welcome prompt → PIN entry → trigger ENS blast → confirm or repeat',
    graph: {
      entry_node_id: 'welcome',
      nodes: {
        welcome: {
          id:   'welcome',
          type: 'say',
          x:    80,   y: 100,
          text: 'Welcome to the Emergency Notification System. Please enter your PIN followed by the pound key.',
          next: 'pin_gather',
        },
        pin_gather: {
          id:            'pin_gather',
          type:          'gather',
          x:             320, y: 100,
          variable_name: 'entered_pin',
          max_digits:    6,
          timeout_seconds: 10,
          prompt_text:   'Enter PIN:',
          branches: {
            _default: 'check_pin',
            timeout:  'repeat_prompt',
          },
        },
        check_pin: {
          id:             'check_pin',
          type:           'condition',
          x:              560, y: 100,
          variable:       'entered_pin',
          operator:       'ens_pin_valid',
          expected_value: '',
          true_node:      'launch_options',
          false_node:     'bad_pin',
        },
        bad_pin: {
          id:   'bad_pin',
          type: 'say',
          x:    560, y: 260,
          text: 'Incorrect PIN. Please try again.',
          next: 'pin_gather',
        },
        repeat_prompt: {
          id:   'repeat_prompt',
          type: 'say',
          x:    320, y: 260,
          text: 'No input received. Please try again.',
          next: 'pin_gather',
        },
        launch_options: {
          id:   'launch_options',
          type: 'gather',
          x:    800, y: 100,
          variable_name:   'launch_choice',
          max_digits:      1,
          timeout_seconds: 10,
          prompt_text:     'PIN accepted. Press 1 to send the emergency notification now. Press 2 to cancel.',
          branches: {
            '1':      'trigger_ens',
            '2':      'cancel_say',
            timeout:  'launch_options',
            _default: 'launch_options',
          },
        },
        trigger_ens: {
          id:                   'trigger_ens',
          type:                 'ens',
          x:                    1040, y: 100,
          ens_configuration_id: 0,
          ens_config_var:       'ens_configuration_id',
          recording_file_var:   '',
          next:                 'blast_confirm',
        },
        blast_confirm: {
          id:   'blast_confirm',
          type: 'say',
          x:    1280, y: 100,
          text: 'Emergency notification has been sent. All contacts are being notified. Goodbye.',
          next: 'end',
        },
        cancel_say: {
          id:   'cancel_say',
          type: 'say',
          x:    800, y: 260,
          text: 'Notification cancelled. Goodbye.',
          next: 'end',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    1520, y: 100,
        },
      },
    },
  },

  ers_basic: {
    name:        'ERS Emergency Response Flow (Template)',
    description: 'Caller identification → press 1 for emergency → ERS conference bridge',
    graph: {
      entry_node_id: 'announce',
      nodes: {
        announce: {
          id:   'announce',
          type: 'say',
          x:    80, y: 100,
          text: 'You have reached the Emergency Response System. Your call may be recorded.',
          next: 'menu',
        },
        menu: {
          id:            'menu',
          type:          'gather',
          x:             320, y: 100,
          variable_name: 'menu_choice',
          max_digits:    1,
          timeout_seconds: 12,
          prompt_text:   'Press 1 to report an emergency and be connected to a response team. Press 2 to hear this menu again. Press 9 to end this call.',
          branches: {
            '1':      'set_priority',
            '2':      'menu',
            '9':      'goodbye',
            timeout:  'menu',
            _default: 'invalid_choice',
          },
        },
        invalid_choice: {
          id:   'invalid_choice',
          type: 'say',
          x:    320, y: 260,
          text: 'Invalid selection. Please try again.',
          next: 'menu',
        },
        set_priority: {
          id:       'set_priority',
          type:     'set_variable',
          x:        560, y: 100,
          variable: 'ers_priority',
          value:    'HIGH',
          next:     'record_situation',
        },
        record_situation: {
          id:              'record_situation',
          type:            'record_message',
          x:               800, y: 100,
          variable_name:   'situation_recording',
          max_seconds:     30,
          silence_threshold: 500,
          silence_hits:    3,
          prompt_text:     'After the tone, briefly describe your emergency. Press pound when done.',
          next:            'connect_ers',
        },
        connect_ers: {
          id:   'connect_ers',
          type: 'say',
          x:    1040, y: 100,
          text: 'Connecting you to the emergency response team now. Please stay on the line.',
          next: 'ers_bridge',
        },
        ers_bridge: {
          id:                   'ers_bridge',
          type:                 'ers',
          x:                    1280, y: 100,
          ers_configuration_id: 0,
        },
        goodbye: {
          id:   'goodbye',
          type: 'say',
          x:    320, y: 400,
          text: 'Thank you for calling. Stay safe. Goodbye.',
          next: 'end',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    560, y: 400,
        },
      },
    },
  },

  ivr_simple: {
    name:        'Simple IVR Menu (Template)',
    description: 'Two-level DTMF menu with TTS prompts — easy starting point',
    graph: {
      entry_node_id: 'greet',
      nodes: {
        greet: {
          id:   'greet',
          type: 'say',
          x:    80, y: 100,
          text: 'Thank you for calling. Please listen carefully to the following options.',
          next: 'main_menu',
        },
        main_menu: {
          id:            'main_menu',
          type:          'gather',
          x:             320, y: 100,
          variable_name: 'main_choice',
          max_digits:    1,
          timeout_seconds: 10,
          prompt_text:   'Press 1 for information. Press 2 for support. Press 0 to repeat this menu.',
          branches: {
            '1':      'info',
            '2':      'support',
            '0':      'main_menu',
            timeout:  'main_menu',
            _default: 'main_menu',
          },
        },
        info: {
          id:   'info',
          type: 'say',
          x:    560, y: 60,
          text: 'For more information, please visit our website or call during business hours.',
          next: 'end',
        },
        support: {
          id:   'support',
          type: 'transfer',
          x:    560, y: 200,
          destination: '1000',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    800, y: 100,
        },
      },
    },
  },
};

// ── Handlers ──────────────────────────────────────────────────────────────────

export async function listTemplates(req, res) {
  const list = Object.entries(TEMPLATES).map(([id, t]) => ({
    id,
    name:        t.name,
    description: t.description,
    node_count:  Object.keys(t.graph.nodes).length,
  }));
  res.json({ templates: list });
}

export async function createFromTemplate(req, res) {
  const { id } = req.params;
  const tpl = TEMPLATES[id];
  if (!tpl) {
    return res.status(404).json({ error: `Template '${id}' not found` });
  }

  const customName = req.body?.name;
  const flowUuid   = uuidv4();
  const name       = customName || tpl.name;

  const { rows: [flow] } = await query(
    `INSERT INTO ivr_flows
       (tenant_id, flow_uuid, name, description, graph, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, true, $6)
     RETURNING flow_uuid, name`,
    [
      req.user.tenantId,
      flowUuid,
      name,
      tpl.description,
      JSON.stringify(tpl.graph),
      req.user.id,
    ]
  );

  res.status(201).json({
    flow_uuid: flow.flow_uuid,
    name:      flow.name,
    message:   'Flow created from template. Open the designer to customise it.',
  });
}
