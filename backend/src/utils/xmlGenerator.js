/**
 * FreeSWITCH Dialplan XML Generator
 *
 * Generates a single enrs_ivr.xml that declares an extension for every
 * IVR-bound phone number. The extension invokes the generic Lua executor.
 *
 * The wrapper structure is NOT hardcoded — it depends on where the file is
 * actually being written, per freeSwitchPathService.detectDialplanTargetDir():
 *
 *   nested === true   The target directory sits INSIDE an already-open
 *                      <context name="default"> (default.xml's own nested
 *                      X-PRE-PROCESS include). The file must be a BARE
 *                      <include><extension>...</extension></include> — a
 *                      second nested <context> tag at that splice point is
 *                      invalid XML, and FreeSWITCH's parser silently drops
 *                      the entire fragment with no error and no warning.
 *                      reloadxml still reports success regardless, which is
 *                      what made this failure invisible without a live
 *                      dialplan trace.
 *
 *   nested === false  Flat layout: dialplan/*.xml siblings loaded directly.
 *                      Each file DOES need its own <context name="default">
 *                      wrapper, or FreeSWITCH has no context to attach the
 *                      extension to.
 *
 * Callers must pass { nested } from detectDialplanTargetDir() — never
 * assume one or the other, both layouts are legitimate FreeSWITCH configs.
 */

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

function wrap(nested, headerLines, extensionsBlock) {
  const body = nested
    ? [
        '<include>',
        '',
        extensionsBlock,
        '',
        '</include>',
      ]
    : [
        '<include>',
        '  <context name="default">',
        '',
        extensionsBlock,
        '',
        '  </context>',
        '</include>',
      ];
  return [...headerLines, ...body].join('\n');
}

/**
 * @param {Array<{number, flow_uuid, flow_name, version_number}>} bindings
 * @param {{ nested: boolean, testMode?: { enabled: boolean, callerId: string, testFlowUuids: Set<string> } }} opts
 * @returns {string} XML content
 */
export function generateDialplanXml(bindings = [], { nested, testMode } = {}) {
  const extensions = bindings.map(b => {
    const isTestFlow = testMode?.enabled && testMode.testFlowUuids?.has(b.flow_uuid);
    const lines = [
      `    <!-- Flow: ${escapeXml(b.flow_name)} | UUID: ${b.flow_uuid} | Version: ${b.version_number} -->`,
    ];
    if (isTestFlow) {
      lines.push(
        `    <!-- TEST MODE — caller_id_number overridden so short lab extensions pass the 7+ char validation on ERS/ENS internal APIs. Remove by disabling Test Mode in Settings. -->`
      );
    }
    lines.push(
      `    <extension name="enrs_ivr_${escapeXml(b.number)}" continue="false">`,
      `      <condition field="destination_number" expression="^${escapeXml(b.number)}$">`,
      `        <action application="set" data="enrs_flow_uuid=${b.flow_uuid}"/>`,
    );
    if (isTestFlow) {
      lines.push(
        `        <action application="set" data="caller_id_number=${escapeXml(testMode.callerId)}"/>`
      );
    }
    lines.push(
      `        <action application="set" data="effective_caller_id_number=\${caller_id_number}"/>`,
      `        <action application="lua"  data="ivr_executor.lua"/>`,
      `      </condition>`,
      `    </extension>`,
    );
    return lines.join('\n');
  }).join('\n\n');

  const header = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!--',
    `  ENRS IVR Dialplan`,
    `  Generated:   ${new Date().toISOString()}`,
    `  Flow count:  ${bindings.length}`,
    `  Layout:      ${nested ? 'nested include (bare, no <context> wrapper)' : 'flat sibling (wrapped in <context name="default">)'}`,
    '  DO NOT EDIT MANUALLY.',
    '  Regenerate via: IVR Builder UI → Deploy.',
    '-->',
  ];

  return wrap(nested, header, extensions || '    <!-- No IVR numbers bound yet -->');
}

/**
 * Generate a minimal healthcheck dialplan entry used by the diagnostics
 * test call to verify dialplan load without a real IVR flow.
 */
export function generateDiagnosticsXml({ nested } = {}) {
  const header = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- ENRS diagnostics probe extension -->',
  ];
  const extension = [
    '    <extension name="enrs_diagnostics_probe">',
    '      <condition field="destination_number" expression="^enrs_probe_99999$">',
    '        <action application="answer"/>',
    '        <action application="sleep" data="500"/>',
    '        <action application="hangup" data="NORMAL_CLEARING"/>',
    '      </condition>',
    '    </extension>',
  ].join('\n');

  return wrap(nested, header, extension);
}
