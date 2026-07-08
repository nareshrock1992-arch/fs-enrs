/**
 * ContactPicker — dual-pane picker for ENS/ERS responder mapping.
 *
 * Props:
 *   groups        Array of { id, name, member_count }
 *   contacts      Array of { id, first_name, last_name, mobile_number }
 *   selectedGroupIds    number[]
 *   selectedContactIds  number[]
 *   onChange      ({ group_ids, contact_ids }) => void
 *   label         string   (optional section label)
 *   hideContacts  boolean  (omit individual-contacts tab — use for ERS tiers)
 */
import { useState, useMemo } from 'react';
import { Search, X, Users, User, Check } from 'lucide-react';

export default function ContactPicker({
  groups = [],
  contacts = [],
  selectedGroupIds = [],
  selectedContactIds = [],
  onChange,
  label,
  hideContacts = false,
}) {
  const [tab, setTab]   = useState('groups');
  const [q, setQ]       = useState('');
  const selGids = new Set(selectedGroupIds.map(Number));
  const selCids = new Set(selectedContactIds.map(Number));

  const filteredGroups = useMemo(() =>
    groups.filter(g => g.name.toLowerCase().includes(q.toLowerCase())),
  [groups, q]);

  const filteredContacts = useMemo(() =>
    contacts.filter(c => {
      const full = `${c.first_name} ${c.last_name} ${c.mobile_number}`.toLowerCase();
      return full.includes(q.toLowerCase());
    }),
  [contacts, q]);

  function toggleGroup(id) {
    const next = new Set(selGids);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange({ group_ids: [...next], contact_ids: [...selCids] });
  }

  function toggleContact(id) {
    const next = new Set(selCids);
    next.has(id) ? next.delete(id) : next.add(id);
    onChange({ group_ids: [...selGids], contact_ids: [...next] });
  }

  function removeGroup(id) {
    const next = new Set(selGids);
    next.delete(id);
    onChange({ group_ids: [...next], contact_ids: [...selCids] });
  }

  function removeContact(id) {
    const next = new Set(selCids);
    next.delete(id);
    onChange({ group_ids: [...selGids], contact_ids: [...next] });
  }

  const selectedGroupObjs   = groups.filter(g   => selGids.has(g.id));
  const selectedContactObjs = contacts.filter(c => selCids.has(c.id));
  const totalSelected = selGids.size + selCids.size;

  const effectiveTabs = hideContacts ? ['groups'] : ['groups', 'contacts'];

  return (
    <div className="space-y-1.5">
      {label && (
        <div className="flex items-center justify-between">
          <label className="label mb-0">{label}</label>
          {totalSelected > 0 && (
            <span className="text-xs text-brand font-semibold">
              {selGids.size > 0 && `${selGids.size} group${selGids.size > 1 ? 's' : ''}`}
              {selGids.size > 0 && selCids.size > 0 && ' · '}
              {selCids.size > 0 && `${selCids.size} contact${selCids.size > 1 ? 's' : ''}`}
              {' '}selected
            </span>
          )}
        </div>
      )}

      <div className="border border-surface-border rounded-lg overflow-hidden">
        <div className="grid grid-cols-2 divide-x divide-surface-border" style={{ minHeight: 260 }}>

          {/* ── Left: picker ── */}
          <div className="flex flex-col">
            {/* tabs */}
            {!hideContacts && (
              <div className="flex border-b border-surface-border">
                {effectiveTabs.map(t => (
                  <button key={t} onClick={() => { setTab(t); setQ(''); }}
                    className={`flex-1 py-2 text-xs font-semibold flex items-center justify-center gap-1.5
                      ${tab === t
                        ? 'text-brand border-b-2 border-brand bg-surface-hover'
                        : 'text-text-muted hover:text-text-primary hover:bg-surface-hover'
                      }`}>
                    {t === 'groups' ? <Users size={12} /> : <User size={12} />}
                    {t === 'groups' ? 'Groups' : 'Contacts'}
                  </button>
                ))}
              </div>
            )}
            {hideContacts && (
              <div className="flex items-center gap-1.5 px-3 py-2 border-b border-surface-border bg-surface-hover">
                <Users size={12} className="text-text-muted" />
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">Groups</span>
              </div>
            )}

            {/* search */}
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
              <input
                className="w-full pl-8 pr-3 py-2 text-xs bg-transparent border-b border-surface-border
                           text-text-primary placeholder:text-text-muted outline-none"
                placeholder={tab === 'groups' ? 'Search groups…' : 'Search contacts…'}
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            </div>

            {/* list */}
            <div className="flex-1 overflow-y-auto" style={{ maxHeight: 200 }}>
              {tab === 'groups' && filteredGroups.map(g => (
                <button key={g.id} onClick={() => toggleGroup(g.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs
                    hover:bg-surface-hover transition-colors
                    ${selGids.has(g.id) ? 'bg-brand/5' : ''}`}>
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                    ${selGids.has(g.id)
                      ? 'bg-brand border-brand'
                      : 'border-surface-border'}`}>
                    {selGids.has(g.id) && <Check size={9} className="text-white" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 truncate font-medium text-text-primary">{g.name}</span>
                  {g.member_count != null && (
                    <span className="text-text-muted text-[10px]">{g.member_count}</span>
                  )}
                </button>
              ))}
              {tab === 'contacts' && filteredContacts.map(c => (
                <button key={c.id} onClick={() => toggleContact(c.id)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-xs
                    hover:bg-surface-hover transition-colors
                    ${selCids.has(c.id) ? 'bg-brand/5' : ''}`}>
                  <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0
                    ${selCids.has(c.id)
                      ? 'bg-brand border-brand'
                      : 'border-surface-border'}`}>
                    {selCids.has(c.id) && <Check size={9} className="text-white" strokeWidth={3} />}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="font-medium text-text-primary truncate block">
                      {c.first_name} {c.last_name}
                    </span>
                    <span className="text-text-muted font-mono truncate block text-[10px]">
                      {c.mobile_number}
                    </span>
                  </span>
                </button>
              ))}
              {tab === 'groups' && filteredGroups.length === 0 && (
                <p className="text-xs text-text-muted p-3 text-center">No groups found</p>
              )}
              {tab === 'contacts' && filteredContacts.length === 0 && (
                <p className="text-xs text-text-muted p-3 text-center">No contacts found</p>
              )}
            </div>
          </div>

          {/* ── Right: selected items ── */}
          <div className="flex flex-col bg-surface-hover/30">
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-surface-border">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                Selected
              </span>
              {totalSelected > 0 && (
                <span className="ml-auto text-[10px] bg-brand text-white rounded-full px-1.5 py-0.5 font-bold">
                  {totalSelected}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1" style={{ maxHeight: 228 }}>
              {selectedGroupObjs.length > 0 && (
                <div className="space-y-1">
                  {!hideContacts && (
                    <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1">Groups</p>
                  )}
                  {selectedGroupObjs.map(g => (
                    <div key={g.id}
                      className="flex items-center gap-1.5 bg-brand/10 text-brand rounded px-2 py-1 text-xs">
                      <Users size={10} className="flex-shrink-0" />
                      <span className="flex-1 truncate font-medium">{g.name}</span>
                      {g.member_count != null && (
                        <span className="text-brand/60 text-[10px]">{g.member_count} members</span>
                      )}
                      <button onClick={() => removeGroup(g.id)}
                        className="flex-shrink-0 hover:text-red-500 transition-colors">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {!hideContacts && selectedContactObjs.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider px-1 mt-2">
                    Individual Contacts
                  </p>
                  {selectedContactObjs.map(c => (
                    <div key={c.id}
                      className="flex items-center gap-1.5 bg-surface-panel border border-surface-border rounded px-2 py-1 text-xs">
                      <User size={10} className="flex-shrink-0 text-text-muted" />
                      <span className="flex-1 min-w-0">
                        <span className="truncate block text-text-primary font-medium">
                          {c.first_name} {c.last_name}
                        </span>
                        <span className="truncate block text-text-muted font-mono text-[10px]">
                          {c.mobile_number}
                        </span>
                      </span>
                      <button onClick={() => removeContact(c.id)}
                        className="flex-shrink-0 hover:text-red-500 transition-colors">
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {totalSelected === 0 && (
                <p className="text-xs text-text-muted text-center pt-8">
                  Nothing selected yet.<br />
                  <span className="text-[11px]">Click items on the left to add them.</span>
                </p>
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
