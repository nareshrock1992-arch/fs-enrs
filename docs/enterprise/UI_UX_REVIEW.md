# UI / UX Review

## Cycle 3 (2026-11-02) — changed and viewed in a browser

Viewed in the in-app browser against a disposable local stack (PostgreSQL, backend and Vite on loopback, synthetic
data for two tenants and every role; telephony, Redis and TTS pointed at closed ports). Desktop (1024 px) and phone
(375 px) widths. No real call, no real tenant data.

| Area | Change | Checked in the browser |
|---|---|---|
| Navigation | Regrouped: Dashboard · Operations (Live Monitoring, ERS Live View, ENS Campaigns) · Emergency Services · IVR · Directory · Reports · Administration. Most specific entry highlighted (`/ens/campaigns` is not also "ENS Configurations"). Tested against the real menu per role | SUPER_ADMIN and tenant ADMIN menus; `/audit` typed directly by ADMIN redirects |
| Phone layout | Sidebar is a slide-over with a backdrop, closes on navigation and Escape; page keeps the full width | 375 px: no sideways scroll, menu opens/closes |
| Confirmations | One shared, non-blocking dialog replaces 20 browser `confirm()` boxes; title, message, labelled buttons; Cancel focused for destructive actions | Delete group: Escape cancels, record kept |
| Notices | 13 silent failures now show a notice | — (unit-tested) |
| Audit Log | Record-type and tenant filters, readable action names, record count, Clear filters, Retry, loading skeleton, details drawer (tenant names resolved) instead of raw JSON | Filters, keyboard-opened details |
| Tables | Clickable rows reachable by Tab and opened by Enter/Space; `Td` passes attributes | Audit Log rows |
| Change password | Header button opened a non-existent page; now a dialog with a live rule checklist | Weak password: checklist and disabled button; server refuses the same |
| ENS Campaigns | "All" tab was always empty; cards show recipient outcomes (answered / not reached / pending) instead of attempt counters; "Completed today" by date | Empty-list bug found and fix confirmed; outcome SQL checked on the test database (the running test backend predated that change) |
| Dashboard | Stat labels wrap instead of truncating; four columns only at `xl` | Both widths |
| IVR designer | Toolbar wraps instead of clipping Publish; new rule violations shown on the nodes | Legacy flow showed both errors on the right nodes |
| Design language | Removed backdrop blur, `shadow-2xl` and extra rounding from modals, drawers and the media player bar; drawer never wider than the screen | — |
| Accessibility | Names on icon-only actions in 10 list pages; dialog roles and labels; menu button `aria-expanded`; theme button names the theme it switches to | Via the accessibility tree |

## Not reviewed yet

ENS / ERS configuration forms, Contacts, Users, Settings, Media Library (redesigned in an earlier mission), the
monitoring widgets, Reports pages beyond Cycle 2, dark theme. The IVR designer's inspector panel was not exercised.
