/**
 * FreeSWITCH SIP Gateway XML Generator — Phase 4.
 *
 * Generates the gateway XML fragment FreeSWITCH's mod_sofia loads from
 * ${FS_SIP_PROFILE_DIR}/external/<name>.xml (the standard location for
 * an external/trunk gateway on a default install). Written and reloaded
 * through the same generate → write → reloadxml → verify pipeline
 * deploymentEngine.js already uses for IVR dialplan XML — see
 * services/gatewayDeployment.js.
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
 * @param {{name, host, port, username, password, register, caller_id_in_from}} gw
 */
export function generateGatewayXml(gw) {
  const params = [
    `      <param name="username" value="${escapeXml(gw.username || gw.name)}"/>`,
    gw.password ? `      <param name="password" value="${escapeXml(gw.password)}"/>` : null,
    `      <param name="realm" value="${escapeXml(gw.host)}"/>`,
    `      <param name="proxy" value="${escapeXml(gw.host)}:${escapeXml(gw.port || 5060)}"/>`,
    `      <param name="register" value="${gw.register ? 'true' : 'false'}"/>`,
    `      <param name="caller-id-in-from" value="${gw.caller_id_in_from ? 'true' : 'false'}"/>`,
  ].filter(Boolean).join('\n');

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!--',
    `  ENRS SIP Gateway: ${escapeXml(gw.name)} (${escapeXml(gw.type || 'generic_sip')})`,
    `  Generated: ${new Date().toISOString()}`,
    '  DO NOT EDIT MANUALLY.',
    '  Regenerate via: Settings → Telephony Gateways.',
    '-->',
    '<include>',
    `  <gateway name="${escapeXml(gw.name)}">`,
    params,
    '  </gateway>',
    '</include>',
  ].join('\n');
}
