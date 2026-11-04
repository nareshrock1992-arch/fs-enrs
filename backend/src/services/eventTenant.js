// ── Which tenant does a live event belong to? ─────────────────────────────────
//
// Internal (Lua) and background paths carry no user, so the tenant comes from the record
// the event describes. These links never change for a record, so answers are cached;
// a failed lookup resolves to null, which emitInternal delivers to SUPER_ADMINs only.
// Never rejects: a reporting event must not disturb the call path that raised it.

import { query } from '../db/pool.js';
import { logger } from '../infrastructure/index.js';

const MAX_CACHED = 5000;
const cache = new Map();

function lookup(key, sql, param) {
  const known = cache.get(key);
  if (known) return known;
  if (cache.size >= MAX_CACHED) cache.clear();
  const tenant = Promise.resolve()
    .then(() => query(sql, [param]))
    .then((res) => {
      const id = res?.rows?.[0]?.tenant_id ?? null;
      if (id == null) cache.delete(key);        // the record may appear in a moment
      return id;
    })
    .catch((err) => {
      cache.delete(key);
      logger.warn({ module: 'socket', key, err: err.message }, 'Event tenant lookup failed — event limited to SUPER_ADMIN');
      return null;
    });
  cache.set(key, tenant);
  return tenant;
}

export const campaignTenant = (id) => lookup(`campaign:${id}`,
  `SELECT e.tenant_id FROM ens_campaigns c JOIN ens_configurations e ON e.id = c.ens_configuration_id WHERE c.id = $1`, id);
export const ensConfigTenant = (id) => lookup(`ens:${id}`,
  'SELECT tenant_id FROM ens_configurations WHERE id = $1', id);
export const ensNotificationTenant = (uuid) => lookup(`notif:${uuid}`,
  `SELECT e.tenant_id FROM ens_notifications n JOIN ens_configurations e ON e.id = n.ens_configuration_id WHERE n.notification_uuid = $1`, uuid);
export const ersConfigTenant = (id) => lookup(`ers:${id}`,
  'SELECT tenant_id FROM ers_configurations WHERE id = $1', id);
export const ersIncidentTenant = (uuid) => lookup(`incident:${uuid}`,
  `SELECT COALESCE(i.tenant_id, e.tenant_id) AS tenant_id FROM ers_incidents i
     JOIN ers_configurations e ON e.id = i.ers_configuration_id WHERE i.incident_uuid = $1`, uuid);
export const ersQueueTenant = (id) => lookup(`queue:${id}`,
  `SELECT e.tenant_id FROM ers_queues q JOIN ers_configurations e ON e.id = q.ers_configuration_id WHERE q.id = $1`, id);
