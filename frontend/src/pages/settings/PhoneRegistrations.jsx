import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, PhoneCall } from 'lucide-react';
import { api } from '../../api/client.js';
import { useAuthStore } from '../../store/authStore.js';
import PageHeader from '../../components/ui/PageHeader.jsx';
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';
import {
  connectionLabel, deviceLabel, addressLabel, healthOf, trunkLabel, uptimeLabel, matchesSearch,
} from './phoneRegistrationsModel.js';

// Phone registrations and SIP trunk status (read-only). Owner 2026-11-25: all admins;
// tenant admins see only their own extensions and trunks (decided on the server).
const TONE = { ok: 'text-emerald-500', warn: 'text-amber-500', bad: 'text-red-500', muted: 'text-text-muted' };

function Counter({ label, value, alert = false }) {
  return (
    <div className="card !py-2.5 !px-3.5">
      <div className="text-xs text-text-muted">{label}</div>
      <div className={`text-xl font-semibold ${alert && value > 0 ? 'text-red-500' : 'text-text-primary'}`}
           data-testid={`count-${label}`}>{value ?? '—'}</div>
    </div>
  );
}

function Detail({ label, children }) {
  return (
    <div className="flex gap-3 text-xs py-0.5">
      <span className="w-32 shrink-0 text-text-muted">{label}</span>
      <span className="text-text-primary break-all">{children}</span>
    </div>
  );
}

export default function PhoneRegistrations() {
  const activeTenantId = useAuthStore(s => s.activeTenantId);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(null);       // key of the expanded row

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.phoneRegistrations.list());
      setError('');
    } catch (e) {
      setError(e.message || 'Registrations could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setOpen(null); load(); }, [activeTenantId, load]);

  const rows = useMemo(
    () => (data?.registrations || []).filter(r => matchesSearch(r, search)),
    [data, search],
  );
  const s = data?.summary || {};
  const updated = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Phone Registrations"
        icon={PhoneCall}
        description={data?.scope === 'tenant'
          ? 'Phones of your organization\'s contacts and departments, and your SIP trunks. Read-only.'
          : 'Which phones are signed in to the phone system, from where, and the state of the SIP trunks. Read-only.'}
      >
        <button type="button" onClick={load} disabled={loading} className="btn-ghost">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} aria-hidden="true" /> Refresh
        </button>
      </PageHeader>

      {error && <div role="alert" className="card border-red-500/30 text-sm text-red-500">{error}</div>}
      {updated && <div className="text-xs text-text-muted">Updated {updated}</div>}

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Counter label="Registered" value={s.registered} />
        <Counter label="Not answering" value={s.notReachable} alert />
        <Counter label="Browser phones" value={s.browserPhones} />
        <Counter label="Same extension twice" value={s.duplicateExtensions} alert />
        <Counter label="Trunks with problems" value={s.trunksWithProblems} alert />
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">Phones</h2>
        <input className="input" type="search" value={search} onChange={e => setSearch(e.target.value)}
               placeholder="Search extension, IP, device or MAC" aria-label="Search phones" />
        <Table>
          <thead>
            <tr>
              <Th>Extension</Th><Th>Device</Th><Th>IP address</Th><Th>Connection</Th><Th>MAC</Th><Th>Health</Th>
            </tr>
          </thead>
          <tbody>
            {data && rows.length === 0 && (
              <EmptyRow cols={6} message={search ? 'No phone matches the search.' : 'No phone is signed in right now.'} />
            )}
            {rows.map(r => {
              const key = `${r.profile}|${r.extension}|${r.ip}|${r.port}`;
              const h = healthOf(r);
              return (
                <Fragment key={key}>
                  <Tr onClick={() => setOpen(open === key ? null : key)} selected={open === key}
                      label={`Extension ${r.extension}, show details`}>
                    <Td className="font-medium">
                      {r.extension}
                      {r.duplicate && (
                        <span className="ml-2 text-[10px] text-amber-500" title="This extension is signed in on more than one device">
                          twice
                        </span>
                      )}
                    </Td>
                    <Td>{deviceLabel(r)}</Td>
                    <Td>{addressLabel(r)}</Td>
                    <Td>{connectionLabel(r)}</Td>
                    <Td className={r.mac ? '' : 'text-text-muted'}>{r.mac || 'Not reported'}</Td>
                    <Td className={TONE[h.tone]}>{h.text}</Td>
                  </Tr>
                  {open === key && (
                    <tr>
                      <td colSpan={6} className="px-4 py-3 bg-surface-hover/40">
                        <Detail label="SIP address">{r.extension}@{r.realm}</Detail>
                        <Detail label="Device (as reported)">{r.device || '—'}</Detail>
                        <Detail label="Seen from">{r.ip ? `${r.ip}:${r.port}` : '—'}{r.browserPhone ? ' (FS-CC relay)' : ''}</Detail>
                        <Detail label="Contact">{r.contact || '—'}</Detail>
                        <Detail label="SIP profile">{r.profile}</Detail>
                        <Detail label="Response time">{Number.isFinite(r.pingMs) ? `${r.pingMs} ms` : 'Not checked'}</Detail>
                        <Detail label="MAC address">{r.mac || 'Not reported by this phone (softphones and browsers usually do not send it)'}</Detail>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-text-primary">SIP trunks</h2>
        <Table>
          <thead>
            <tr><Th>Trunk</Th><Th>Server</Th><Th>State</Th><Th>Response time</Th><Th>Up for</Th><Th>Calls in / out (failed)</Th></tr>
          </thead>
          <tbody>
            {data && (data.gateways || []).length === 0 && <EmptyRow cols={6} message="No SIP trunk is configured." />}
            {(data?.gateways || []).map(g => {
              const t = trunkLabel(g);
              return (
                <Tr key={g.name}>
                  <Td className="font-medium">{g.name}</Td>
                  <Td>{g.proxy || g.realm || '—'}</Td>
                  <Td className={TONE[t.tone]}>{t.text}</Td>
                  <Td>{Number.isFinite(g.pingMs) ? `${g.pingMs} ms` : 'Not checked'}</Td>
                  <Td>{uptimeLabel(g.uptimeSeconds)}</Td>
                  <Td>{g.callsIn ?? 0} / {g.callsOut ?? 0} ({(g.failedIn ?? 0) + (g.failedOut ?? 0)} failed)</Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </section>
    </div>
  );
}
