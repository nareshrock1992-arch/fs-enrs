# Environment Setup — Onboarding a New Customer FreeSWITCH Box

This is a copy-pasteable runbook for connecting fs-enrs to a **new**
FreeSWITCH install you have zero prior context on. Follow it in order —
each step depends on the one before it. Do not skip step 2; it is what
catches the class of bug where files deploy successfully but calls never
route through them (see "Why this exists" below).

## Why this exists

Different FreeSWITCH installs assemble their live `default` dialplan
context differently. Some load extensions straight from `dialplan/*.xml`.
Others have `dialplan/default.xml` declare `<context name="default">` and
then nest a second include inside it, e.g.:

```xml
<context name="default">
  <X-PRE-PROCESS cmd="include" data="default/*.xml"/>
</context>
```

On a box like that, writing our generated `enrs_ivr.xml` straight into
`dialplan/` produces a **second, sibling** `<context name="default">` node
that FreeSWITCH's config tree never merges into the one it actually routes
calls through. `reloadxml` reports `+OK` regardless — there is no error
anywhere. The only symptom is: a customer dials the number and nothing
happens. This runbook's step 2 (diagnostics) and the app's own deploy-time
verification exist specifically so this is caught automatically, not
discovered an hour into tailing `fs_cli` logs during a live test call.

## Steps

### 1. Configure backend/.env

Set these before starting the backend for the first time:

```bash
FS_DIALPLAN_DIR=/etc/freeswitch/dialplan      # search root — app auto-detects the real target under this
FS_SCRIPT_DIR=/etc/freeswitch/scripts
FS_SOUND_DIR=/usr/share/freeswitch/sounds
FS_RECORDING_DIR=/var/lib/freeswitch/recordings
INTERNAL_API_KEY=<a long random string>
```

`FS_DIALPLAN_DIR` is a **search root**, not a literal write target — the
app reads `default.xml` under it and figures out where extensions actually
need to go (see "Why this exists" above). Set it to the box's real
`dialplan/` directory; the app resolves the rest. If it accidentally gets
pointed at the nested include directory itself (e.g.
`/etc/freeswitch/dialplan/default`), the detector now recognizes that too
by checking the parent directory's `default.xml` — but the documented,
intended value remains the `dialplan/` root.

`INTERNAL_API_KEY` **must exactly match** whatever is exported as
`FS_INTERNAL_KEY` on the FreeSWITCH box itself (in `vars.xml` or a systemd
environment file) — Lua scripts send this as `X-Internal-Key` on every
call to the backend. A near-miss (trailing whitespace, different casing,
copy-paste truncation) fails silently as 401s buried in Lua's `curl`
output, not a clear error. Diff the two values character-for-character if
anything internal-API-related misbehaves.

### 2. Run diagnostics — confirm the dialplan chain BEFORE deploying anything

```
GET /api/v1/deployment/diagnostics
```

(or the **Diagnostics** tab in the Deployment Dashboard UI).

Look specifically at the **"Dialplan Include Chain"** check. It reports the
fully-resolved directory FreeSWITCH will actually load extensions from —
this may or may not be the same as `FS_DIALPLAN_DIR`. Confirm:

- The resolved target directory is real, writable by the backend process,
  and readable by the `freeswitch` OS user (see the **"Permissions:
  Dialplan Target Directory"** check — it compares file ownership/mode
  against the actual `freeswitch` system user on this box, not a guess).
- If the chain check shows a **warning** because `freeswitch.xml` couldn't
  be read from this box, verify the include chain manually:
  `grep -A2 'X-PRE-PROCESS.*dialplan' /etc/freeswitch/freeswitch.xml` and
  `cat /etc/freeswitch/dialplan/default.xml`.

Do not proceed past this step with a **fail** on the dialplan chain or
target-directory permission checks — every later step will silently not
work.

### 3. Run the conflict scan — resolve any shadowing legacy extensions

Same diagnostics response, **"Dialplan Conflict Scan"** check. This scans
every other `*.xml` file already in the detected target directory for
`destination_number` conditions that could also match a number you're
about to bind (common culprits on a re-purposed box: a legacy
`dialplan/default/enrs_ivr.xml`, `enrs.xml` referencing
`dial_911_conference.lua` / `blast_call.lua` from a prior install).

An extension with `continue="false"` that matches your number and loads
**earlier** in glob order than our generated `enrs_ivr.xml` will silently
absorb the call — the number never reaches this app's Lua executor, with
no error logged anywhere. Rename, remove, or disable any conflicting
legacy extension the scan flags before deploying.

### 4. Create a service number

**Emergency Config → Service Registry** — register a number with:
- An ERS or ENS configuration assigned
- An IVR flow assigned
- `is_active = true`

### 5. Assign ERS/ENS config to every relevant IVR node

In the **IVR Builder**, any ERS or ENS node still showing `Config ?`
has no configuration assigned and will fail at runtime. Assign a
configuration to every such node before publishing.

### 6. Publish the flow

Publish from the IVR Builder toolbar. It must complete with **0
validation errors** — dangling references, missing configs, and true
dead-end loops all block publish. (A menu node looping back to itself for
retry/invalid input is expected and does not block publish.)

### 7. Bind the number

Use the **Bind Numbers** action (📞 icon in the builder toolbar) to attach
the published flow to the number registered in step 4.

### 8. Deploy — and trust the banner this time

Click **Deploy**. As of this app version, the success banner is only shown
after the backend has independently confirmed (via `xml_locate`) that the
extension is actually live in FreeSWITCH's routing table — not just that
`reloadxml` returned `+OK`. If deploy fails with *"Deployed files were
written but FreeSWITCH did not load the extension"*, go back to step 2 —
the dialplan chain detection found something the include pattern doesn't
match. This is the exact failure this runbook exists to catch before a
human has to.

### 9. Place a real test call

From a SIP extension registered on this FreeSWITCH box, dial the number
from step 4. Confirm the flow executes as designed. Tail both logs side
by side while testing:

```bash
fs_cli -x "console loglevel debug"
tail -f /path/to/fs-enrs/backend/backend.log
```

If the call doesn't route as expected even after a green deploy banner,
the extension loaded but something else in the flow (ERS/ENS config,
audio file, Lua executor path) is the next thing to check — the dialplan
routing itself is no longer the suspect at this point.
