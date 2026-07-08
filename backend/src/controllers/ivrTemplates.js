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
  // ── Production ENS: blast caller records & sends notification ────────────────
  ens_blast_caller: {
    name:        'ENS — Blast Caller (Production)',
    description: 'Caller enters PIN → records message → reviews → sends ENS blast to all contacts. ' +
                 'Includes 3-attempt PIN retry and record/review/re-record loop.',
    graph: {
      entry_node_id: 'welcome',
      nodes: {
        // ── Welcome ─────────────────────────────────────────────────────────────
        welcome: {
          id:        'welcome',
          type:      'play',
          x:         80,  y: 120,
          audio_url: '/media/welcome_emergency.wav',
          next:      'init_attempts',
        },
        // Use set_variable to initialise the retry counter
        init_attempts: {
          id:       'init_attempts',
          type:     'set_variable',
          x:        280, y: 120,
          variable: 'pin_attempts',
          value:    '0',
          next:     'enter_pin',
        },
        // ── PIN entry ───────────────────────────────────────────────────────────
        enter_pin: {
          id:              'enter_pin',
          type:            'play',
          x:               480, y: 120,
          audio_url:       '/media/enter_pin.wav',
          next:            'pin_gather',
        },
        pin_gather: {
          id:              'pin_gather',
          type:            'gather',
          x:               680, y: 120,
          variable_name:   'entered_pin',
          max_digits:      6,
          timeout_seconds: 10,
          terminators:     '#',
          branches: {
            _default: 'check_pin',
            timeout:  'pin_timeout',
          },
        },
        pin_timeout: {
          id:        'pin_timeout',
          type:      'play',
          x:         680, y: 300,
          audio_url: '/media/no_input.wav',
          next:      'enter_pin',
        },
        // ── PIN validation ──────────────────────────────────────────────────────
        check_pin: {
          id:             'check_pin',
          type:           'condition',
          x:              880, y: 120,
          variable:       'entered_pin',
          operator:       'ens_pin_valid',
          expected_value: '${destination_number}',
          true_node:      'pin_ok',
          false_node:     'bad_pin',
        },
        bad_pin: {
          id:        'bad_pin',
          type:      'play',
          x:         880, y: 300,
          audio_url: '/media/incorrect_pin.wav',
          next:      'check_attempts',
        },
        // Increment attempt counter then decide whether to retry or give up
        check_attempts: {
          id:        'check_attempts',
          type:      'condition',
          x:         1080, y: 300,
          variable:  'pin_attempts',
          operator:  '==',
          expected_value: '2',
          true_node:  'too_many_attempts',
          false_node: 'inc_attempts',
        },
        inc_attempts: {
          id:       'inc_attempts',
          type:     'set_variable',
          x:        1080, y: 440,
          variable: 'pin_attempts',
          value:    '${pin_attempts+1}',
          next:     'enter_pin',
        },
        too_many_attempts: {
          id:        'too_many_attempts',
          type:      'play',
          x:         1280, y: 300,
          audio_url: '/media/too_many_attempts.wav',
          next:      'end',
        },
        // ── Post-PIN options ────────────────────────────────────────────────────
        pin_ok: {
          id:        'pin_ok',
          type:      'play',
          x:         1080, y: 120,
          audio_url: '/media/pin_accepted.wav',
          next:      'launch_menu',
        },
        launch_menu: {
          id:              'launch_menu',
          type:            'gather',
          x:               1280, y: 120,
          variable_name:   'launch_choice',
          max_digits:      1,
          timeout_seconds: 12,
          prompt_audio_url: '/media/blast_options.wav',
          prompt_text:     'Press 1 to record your emergency message. Press 2 to send a standard blast without recording. Press 9 to cancel.',
          branches: {
            '1':      'record_prompt',
            '2':      'trigger_ens_direct',
            '9':      'blast_cancelled',
            timeout:  'launch_menu',
            _default: 'launch_menu',
          },
        },
        // ── Record message branch ───────────────────────────────────────────────
        record_prompt: {
          id:        'record_prompt',
          type:      'play',
          x:         1480, y: 60,
          audio_url: '/media/record_after_tone.wav',
          next:      'record_msg',
        },
        record_msg: {
          id:               'record_msg',
          type:             'record_message',
          x:                1680, y: 60,
          variable_name:    'recorded_file_path',
          max_seconds:      60,
          silence_threshold: 500,
          silence_hits:     3,
          record_dir:       '/var/lib/freeswitch/recordings',
          next:             'review_menu',
        },
        review_menu: {
          id:              'review_menu',
          type:            'gather',
          x:               1880, y: 60,
          variable_name:   'review_choice',
          max_digits:      1,
          timeout_seconds: 15,
          prompt_audio_url: '/media/review_options.wav',
          prompt_text:     'Press 1 to play back your recording. Press 2 to send the blast now. Press 3 to re-record. Press 9 to cancel.',
          branches: {
            '1':      'playback_preview',
            '2':      'trigger_ens_with_recording',
            '3':      'record_prompt',
            '9':      'blast_cancelled',
            timeout:  'review_menu',
            _default: 'review_menu',
          },
        },
        playback_preview: {
          id:        'playback_preview',
          type:      'play',
          x:         2080, y: 60,
          audio_url: '${recorded_file_path}',
          next:      'review_menu',
        },
        trigger_ens_with_recording: {
          id:                   'trigger_ens_with_recording',
          type:                 'ens',
          x:                    2080, y: 200,
          ens_config_var:       'ens_configuration_id',
          recording_file_var:   'recorded_file_path',
          next:                 'blast_sent',
        },
        // ── Direct blast (no recording) ─────────────────────────────────────────
        trigger_ens_direct: {
          id:                   'trigger_ens_direct',
          type:                 'ens',
          x:                    1480, y: 200,
          ens_config_var:       'ens_configuration_id',
          recording_file_var:   '',
          next:                 'blast_sent',
        },
        blast_sent: {
          id:        'blast_sent',
          type:      'play',
          x:         2280, y: 120,
          audio_url: '/media/blast_sent_confirmation.wav',
          next:      'end',
        },
        blast_cancelled: {
          id:        'blast_cancelled',
          type:      'play',
          x:         1680, y: 300,
          audio_url: '/media/blast_cancelled.wav',
          next:      'end',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    2480, y: 120,
        },
      },
    },
  },

  // ── Production ENS: recipient callback to hear playback ─────────────────────
  ens_playback_callback: {
    name:        'ENS — Recipient Playback Callback (Production)',
    description: 'Recipient calls back (UUUU number), enters PIN, hears the recorded blast message, ' +
                 'confirms receipt or replays. Sets delivery status ANSWERED in ENS log.',
    graph: {
      entry_node_id: 'welcome',
      nodes: {
        welcome: {
          id:        'welcome',
          type:      'play',
          x:         80,  y: 120,
          audio_url: '/media/welcome_playback.wav',
          next:      'enter_pin',
        },
        enter_pin: {
          id:        'enter_pin',
          type:      'play',
          x:         280, y: 120,
          audio_url: '/media/enter_pin.wav',
          next:      'pin_gather',
        },
        pin_gather: {
          id:              'pin_gather',
          type:            'gather',
          x:               480, y: 120,
          variable_name:   'entered_pin',
          max_digits:      6,
          timeout_seconds: 10,
          terminators:     '#',
          branches: {
            _default: 'check_pin',
            timeout:  'no_input_say',
          },
        },
        no_input_say: {
          id:        'no_input_say',
          type:      'play',
          x:         480, y: 300,
          audio_url: '/media/no_input.wav',
          next:      'enter_pin',
        },
        check_pin: {
          id:             'check_pin',
          type:           'condition',
          x:              680, y: 120,
          variable:       'entered_pin',
          operator:       'ens_callback_valid',
          expected_value: '${destination_number}',
          true_node:      'play_message',
          false_node:     'bad_pin',
        },
        bad_pin: {
          id:        'bad_pin',
          type:      'play',
          x:         680, y: 300,
          audio_url: '/media/incorrect_pin.wav',
          next:      'enter_pin',
        },
        play_message: {
          id:        'play_message',
          type:      'play',
          x:         880, y: 120,
          audio_url: '${ens_recording_file}',
          next:      'playback_menu',
        },
        playback_menu: {
          id:              'playback_menu',
          type:            'gather',
          x:               1080, y: 120,
          variable_name:   'playback_choice',
          max_digits:      1,
          timeout_seconds: 10,
          prompt_audio_url: '/media/playback_confirm_options.wav',
          prompt_text:     'Press 1 to confirm you have received this message. Press 2 to replay the message.',
          branches: {
            '1':      'confirm_receipt',
            '2':      'play_message',
            timeout:  'playback_menu',
            _default: 'playback_menu',
          },
        },
        confirm_receipt: {
          id:        'confirm_receipt',
          type:      'play',
          x:         1280, y: 120,
          audio_url: '/media/receipt_confirmed.wav',
          next:      'end',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    1480, y: 120,
        },
      },
    },
  },

  // ── Production ERS: 1222 — Level 1 / Level 2 / Queue scenario ───────────────
  ers_1222_multilevel: {
    name:        'ERS — Emergency 1222 Multi-Level Response (Production)',
    description: 'Caller dials 1222 → selects Level 1 (Fire/Medical/CCB/SCC/Safety) or ' +
                 'Level 2 conference, or joins the queue if capacity is full. ' +
                 'Set ers_configuration_id on the ers nodes to match your ERS config.',
    graph: {
      entry_node_id: 'welcome',
      nodes: {
        // ── Welcome + level select ──────────────────────────────────────────────
        welcome: {
          id:        'welcome',
          type:      'play',
          x:         80,  y: 200,
          audio_url: '/media/welcome_emergency.wav',
          next:      'level_menu',
        },
        level_menu: {
          id:              'level_menu',
          type:            'gather',
          x:               280, y: 200,
          variable_name:   'level_choice',
          max_digits:      1,
          timeout_seconds: 12,
          prompt_audio_url: '/media/level_select_options.wav',
          prompt_text:     'Press 1 for Level 1 emergency response. Press 2 for Level 2 emergency response. Press 9 to end this call.',
          branches: {
            '1':      'level1_announce',
            '2':      'level2_announce',
            '9':      'goodbye',
            timeout:  'level_menu',
            _default: 'invalid_level',
          },
        },
        invalid_level: {
          id:        'invalid_level',
          type:      'play',
          x:         280, y: 400,
          audio_url: '/media/invalid_selection.wav',
          next:      'level_menu',
        },
        // ── Level 1 path ────────────────────────────────────────────────────────
        level1_announce: {
          id:        'level1_announce',
          type:      'play',
          x:         480, y: 80,
          audio_url: '/media/connecting_level1_responders.wav',
          next:      'level1_service_menu',
        },
        level1_service_menu: {
          id:              'level1_service_menu',
          type:            'gather',
          x:               680, y: 80,
          variable_name:   'service_choice',
          max_digits:      1,
          timeout_seconds: 10,
          prompt_audio_url: '/media/service_select_level1.wav',
          prompt_text:     'Press 1 for Fire. Press 2 for Medical. Press 3 for CCB. Press 4 for SCC. Press 5 for Safety.',
          branches: {
            '1':      'connect_l1_fire',
            '2':      'connect_l1_medical',
            '3':      'connect_l1_ccb',
            '4':      'connect_l1_scc',
            '5':      'connect_l1_safety',
            timeout:  'level1_service_menu',
            _default: 'level1_service_menu',
          },
        },
        connect_l1_fire: {
          id:        'connect_l1_fire',
          type:      'play',
          x:         880, y: 20,
          audio_url: '/media/connecting_fire.wav',
          next:      'ers_level1',
        },
        connect_l1_medical: {
          id:        'connect_l1_medical',
          type:      'play',
          x:         880, y: 100,
          audio_url: '/media/connecting_medical.wav',
          next:      'ers_level1',
        },
        connect_l1_ccb: {
          id:        'connect_l1_ccb',
          type:      'play',
          x:         880, y: 180,
          audio_url: '/media/connecting_ccb.wav',
          next:      'ers_level1',
        },
        connect_l1_scc: {
          id:        'connect_l1_scc',
          type:      'play',
          x:         880, y: 260,
          audio_url: '/media/connecting_scc.wav',
          next:      'ers_level1',
        },
        connect_l1_safety: {
          id:        'connect_l1_safety',
          type:      'play',
          x:         880, y: 340,
          audio_url: '/media/connecting_safety.wav',
          next:      'ers_level1',
        },
        ers_level1: {
          id:                   'ers_level1',
          type:                 'ers',
          x:                    1080, y: 180,
          ers_configuration_id: 0,  // Set to Level 1 ERS config ID
        },
        // ── Level 2 path ────────────────────────────────────────────────────────
        level2_announce: {
          id:        'level2_announce',
          type:      'play',
          x:         480, y: 340,
          audio_url: '/media/connecting_level2_responders.wav',
          next:      'level2_service_menu',
        },
        level2_service_menu: {
          id:              'level2_service_menu',
          type:            'gather',
          x:               680, y: 340,
          variable_name:   'service_choice_l2',
          max_digits:      1,
          timeout_seconds: 10,
          prompt_audio_url: '/media/service_select_level2.wav',
          prompt_text:     'Press 1 for Fire. Press 2 for Medical. Press 3 for CCB. Press 4 for SCC. Press 5 for Safety.',
          branches: {
            '1':      'connect_l2_fire',
            '2':      'connect_l2_medical',
            '3':      'connect_l2_ccb',
            '4':      'connect_l2_scc',
            '5':      'connect_l2_safety',
            timeout:  'level2_service_menu',
            _default: 'level2_service_menu',
          },
        },
        connect_l2_fire: {
          id:        'connect_l2_fire',
          type:      'play',
          x:         880, y: 280,
          audio_url: '/media/connecting_fire.wav',
          next:      'ers_level2',
        },
        connect_l2_medical: {
          id:        'connect_l2_medical',
          type:      'play',
          x:         880, y: 360,
          audio_url: '/media/connecting_medical.wav',
          next:      'ers_level2',
        },
        connect_l2_ccb: {
          id:        'connect_l2_ccb',
          type:      'play',
          x:         880, y: 440,
          audio_url: '/media/connecting_ccb.wav',
          next:      'ers_level2',
        },
        connect_l2_scc: {
          id:        'connect_l2_scc',
          type:      'play',
          x:         880, y: 520,
          audio_url: '/media/connecting_scc.wav',
          next:      'ers_level2',
        },
        connect_l2_safety: {
          id:        'connect_l2_safety',
          type:      'play',
          x:         880, y: 600,
          audio_url: '/media/connecting_safety.wav',
          next:      'ers_level2',
        },
        ers_level2: {
          id:                   'ers_level2',
          type:                 'ers',
          x:                    1080, y: 440,
          ers_configuration_id: 0,  // Set to Level 2 ERS config ID
        },
        // ── Common exit ─────────────────────────────────────────────────────────
        goodbye: {
          id:        'goodbye',
          type:      'play',
          x:         480, y: 560,
          audio_url: '/media/goodbye_stay_safe.wav',
          next:      'end',
        },
        end: {
          id:   'end',
          type: 'hangup',
          x:    680, y: 560,
        },
      },
    },
  },

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
