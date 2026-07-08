/**
 * FreeSWITCH Dialplan XML Generator
 *
 * Generates a single enrs_ivr.xml that declares an extension for every
 * IVR-bound phone number.  The extension invokes the generic Lua executor.
 *
 * File is written to ${FS_DIALPLAN_DIR}/enrs_ivr.xml and loaded via
 * <X-PRE-PROCESS cmd="include" data="enrs_ivr.xml"/> in default.xml,
 * OR placed directly in the dialplan directory (auto-loaded on reloadxml).
 */

function escapeXml(s) {
  return String(s ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/**
 * @param {Array<{number, flow_uuid, flow_name, version_number}>} bindings
 * @returns {string} XML content
 */
export function generateDialplanXml(bindings = []) {
  const extensions = bindings.map(b => [
    `    <!-- Flow: ${escapeXml(b.flow_name)} | UUID: ${b.flow_uuid} | Version: ${b.version_number} -->`,
    `    <extension name="enrs_ivr_${escapeXml(b.number)}" continue="false">`,
    `      <condition field="destination_number" expression="^${escapeXml(b.number)}$">`,
    `        <action application="set" data="enrs_flow_uuid=${b.flow_uuid}"/>`,
    `        <action application="set" data="effective_caller_id_number=\${caller_id_number}"/>`,
    `        <action application="lua"  data="ivr_executor.lua"/>`,
    `      </condition>`,
    `    </extension>`,
  ].join('\n')).join('\n\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!--',
    `  ENRS IVR Dialplan`,
    `  Generated:   ${new Date().toISOString()}`,
    `  Flow count:  ${bindings.length}`,
    '  DO NOT EDIT MANUALLY.',
    '  Regenerate via: IVR Builder UI → Deploy.',
    '-->',
    '<include>',
    '  <context name="default">',
    '',
    extensions || '    <!-- No IVR numbers bound yet -->',
    '',
    '  </context>',
    '</include>',
  ].join('\n');
}

/**
 * Generate a minimal healthcheck dialplan entry used by the diagnostics
 * test call to verify dialplan load without a real IVR flow.
 */
export function generateDiagnosticsXml() {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- ENRS diagnostics probe extension -->',
    '<include>',
    '  <context name="default">',
    '    <extension name="enrs_diagnostics_probe">',
    '      <condition field="destination_number" expression="^enrs_probe_99999$">',
    '        <action application="answer"/>',
    '        <action application="sleep" data="500"/>',
    '        <action application="hangup" data="NORMAL_CLEARING"/>',
    '      </condition>',
    '    </extension>',
    '  </context>',
    '</include>',
  ].join('\n');
}
