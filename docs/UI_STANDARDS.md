# UI STANDARDS — fs-enrs

## Stack

- React 18 (functional components, hooks only — no class components)
- Vite build tool
- Tailwind CSS with custom design tokens (`text-text-primary`, `bg-surface`, etc.)
- Lucide React for icons
- React Router v6 for navigation
- Socket.IO client for real-time events

## Design Tokens (Tailwind Custom Classes)

```
Colors:
  text-text-primary     Main content text
  text-text-muted       Secondary/label text
  bg-surface            Card/panel backgrounds
  bg-surface-hover      Hover state
  border-surface-border Table/card borders

Components:
  .btn-primary          Filled action button (indigo/blue)
  .btn-secondary        Outlined cancel button
  .btn-ghost            Transparent icon button
  .input                Form input / select / textarea
  .label                Form field label
```

## Page Layout Pattern

Every CRUD page follows this exact structure:

```jsx
<div className="space-y-4">
  {/* Header: title + primary action */}
  <div className="flex items-center justify-between">
    <h1 className="text-xl font-bold text-text-primary">Entity Name</h1>
    <button onClick={openCreate} className="btn-primary flex items-center gap-1.5">
      <Plus size={15} /> Add Entity
    </button>
  </div>

  {/* Filters (optional) */}
  <div className="flex gap-2">...</div>

  {/* Data Table */}
  <Table>
    <thead><tr><Th>Col</Th>...</tr></thead>
    <tbody>
      {rows.length === 0 ? <EmptyRow cols={N} /> : rows.map(r => (
        <Tr key={r.id}>
          <Td>...</Td>
          <Td>
            <div className="flex gap-1 justify-end">
              <button className="btn-ghost p-1.5"><Pencil size={13} /></button>
              <button className="btn-ghost p-1.5 text-red-500"><Trash2 size={13} /></button>
            </div>
          </Td>
        </Tr>
      ))}
    </tbody>
  </Table>

  {/* Modal (create/edit) */}
  {modal && (
    <Modal title={modal.id ? 'Edit Entity' : 'Create Entity'} onClose={() => setModal(null)}>
      ...form...
      {error && <p className="text-sm text-red-500">{error}</p>}
      <div className="flex gap-2 justify-end pt-2">
        <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="btn-primary">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  )}
</div>
```

## Form Rules

- Always initialize with `EMPTY` constant at top of file
- Optional text fields: `form.field || null` in payload, `r.field || ''` in `openEdit`
- Required numeric FK from `<select>`: `Number(e.target.value) || ''` in `onChange`
- In `handleSave` payload: all numerics explicitly cast with `Number()`
- Show field-level errors in `<p className="text-sm text-red-500">{error}</p>`

## Table Component Props

```jsx
import { Table, Th, Td, Tr, EmptyRow } from '../../components/ui/Table.jsx';

<EmptyRow cols={5} />  // renders colspan="5" "No records found" row
```

## Modal Sizes

```jsx
<Modal size="sm" />   // narrow: confirm/simple forms
<Modal size="md" />   // default: standard CRUD modals
<Modal size="lg" />   // wide: multi-column forms, member lists
<Modal size="xl" />   // full-width: IVR editor, media browser
```

## Badge Variants

```jsx
<Badge variant="success">Active</Badge>
<Badge variant="warning">Pending</Badge>
<Badge variant="danger">Failed</Badge>
<Badge variant="default">Inactive</Badge>
<Badge variant="info">Queued</Badge>
```

## Real-time Pattern (Phase B2)

```jsx
import { useSocket } from '../../context/SocketContext.jsx';

export default function Dashboard() {
  const socket = useSocket();
  const [conferences, setConferences] = useState([]);

  useEffect(() => {
    socket.on('enrs::conference_update', setConferences);
    socket.on('enrs::ens_progress', handleProgress);
    return () => {
      socket.off('enrs::conference_update', setConferences);
      socket.off('enrs::ens_progress', handleProgress);
    };
  }, [socket]);
}
```

## IVR Builder UI (Phase B4)

- Canvas: `reactflow` library with custom node types
- Left panel: draggable node palette (Play Prompt, Collect Digits, Condition, Transfer, etc.)
- Right panel: selected node config form (renders based on node.type)
- Toolbar: Save Draft, Publish Version, Simulate, Version History
- Node colors: play_prompt=blue, collect_digits=purple, condition=amber, transfer=green, hangup=red, ai_intent=pink

## Accessibility

- All form inputs must have associated `<label>` via `htmlFor`
- Icon-only buttons must have `title` attribute: `<button title="Edit">`
- Color alone must not convey meaning — pair badge color with text label
- Focus ring must be visible (Tailwind `focus:ring-2`)
