# Future Roadmap

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21

---

## Reading This Document

This roadmap describes the long-term evolution of the platform across waves. Each wave entry describes the goal, the primary beneficiary, and the architectural preconditions.

**This is not a commitment or a schedule.** It is a forward-compatibility map — the design decisions made today should not foreclose any of the capabilities described here.

---

## Wave Summary

| Wave | Name | Goal |
|---|---|---|
| 0 | Architecture Freeze | Establish architectural foundation before any implementation |
| 1 | Outbound Router | Remove provider coupling from business modules |
| 2 | Observability | Structured logging, health check, session UUID correlation |
| 3 | Communication Engine | Unified session tracking, cross-module call analytics |
| 4 | Provider Layer | Abstract ESL behind Provider interface, enable multi-provider |
| 5 | Routing Policies | Per-tenant routing rules, failover, number normalization |
| 6 | Multi-Site | Multiple FreeSWITCH clusters, one per site |
| 7 | ACD / Contact Center | Agent routing, queues, skills-based dispatch |
| 8 | Additional Channels | SMS, email, push notification through Communication Engine |
| 9 | External Providers | Twilio, Vonage, SBC integration as Provider Layer backends |
| 10 | Analytics Platform | OLAP-grade call analytics, ML-driven insights |

---

## Wave 5 — Routing Policies and Number Normalization

**Preconditions:** Wave 3 (Communication Engine), Wave 4 (Provider Layer)

**Goal:** Allow per-tenant routing rules to be configured without code changes. Enable least-cost routing, time-of-day routing, and gateway failover.

**New capabilities:**
- `gateway_routes` table: per-tenant routing rules (destination type, number pattern, gateway priority)
- `numberNormalizer.js`: active normalization — E.164 conversion, prefix add/strip, per-gateway config
- Gateway failover: if primary gateway fails, Route Engine tries next by priority
- Destination Classifier: full implementation of all 9 DestinationTypes (Wave 1 stubbed most)

**User-visible:** Tenant admins can configure routing rules in a new "Routing Policies" UI section.

---

## Wave 6 — Multi-Site FreeSWITCH

**Preconditions:** Wave 4 (Provider Layer), ESL connection pooling design

**Goal:** Support enterprise customers with multiple physical sites, each running a local FreeSWITCH cluster. Calls originate from the site closest to the caller or responder.

**New capabilities:**
- `esl_connections` table activated as cluster registry (one row per FS instance)
- FreeSWITCH Provider becomes a connection pool: `connections: Map<siteId, EslConnection>`
- CommunicationRequest gains optional `preferredSiteId` hint
- Site selection policy (closest site, least-loaded site, explicit override)
- Cross-site conference bridging via FS conference push (advanced)

**Schema changes:** `esl_connections` schema revised to support per-site metadata, health status, last heartbeat.

**User-visible:** Site assignment in gateway configuration. Reporting shows per-site call volume.

---

## Wave 7 — ACD / Contact Center

**Preconditions:** Wave 5 (Routing Policies), Wave 3 (Communication Engine sessions)

**Goal:** Add an Automatic Call Distributor — inbound call queues, agent routing, skills-based dispatch.

**New capabilities:**
- `cc_queues` table: named queues with SLA targets, priority, overflow rules
- `cc_agents` table: users registered as ACD agents with skills, availability status
- `cc_sessions` table (or use `communication_sessions` with `module = 'CC'`)
- IVR node type: `queue` — place inbound caller in named ACD queue
- Agent desktop UI: accept/reject incoming calls, status toggle (available/busy/break)
- Supervisor UI: real-time queue depth, agent status, call recording access

**Architecture:** The ACD engine is a new module sitting alongside ENS/ERS, calling the Communication Engine to originate agent-leg calls. The Communication Engine's priority queuing (provisioned in Wave 3) activates here.

---

## Wave 8 — SMS and Email Channels

**Preconditions:** Wave 3 (Communication Engine channel field), provider with SMS capability

**Goal:** ENS blasts may use SMS or email as the delivery channel in addition to voice.

**New capabilities:**
- `CommunicationRequest.channel = 'sms' | 'email'` dispatches to SMS/email providers
- SMS Provider: wraps Twilio, Vonage, or a self-hosted SMS gateway
- Email Provider: wraps SMTP or SendGrid
- ENS configuration gains per-contact channel preference (voice → SMS fallback, etc.)
- IVR node type: `send_sms` — fire an SMS mid-call (confirmation code, reference number)

**Architecture:** The Communication Engine routes by `channel` to the correct provider. SMS and email providers implement the same `Provider` interface (minus the `on('answer')` event, which does not apply).

**Note:** ENS database tables (`ens_campaign_deliveries`) already have a `channel` column stub. This activates in Wave 8.

---

## Wave 9 — External Telephony Providers

**Preconditions:** Wave 4 (Provider Layer), Wave 8 (multi-channel)

**Goal:** Route specific call types through Twilio, Vonage, or SBC-connected carriers as alternatives to the on-premise FreeSWITCH cluster.

**New capabilities:**
- `TwilioProvider` implementing the Provider interface
- `VonageProvider` implementing the Provider interface
- Webhook endpoints for Twilio/Vonage status callbacks (translate to standard CallEvents)
- TwiML generation for Twilio (analogous to Lua generation for FreeSWITCH)
- `sip_gateways.provider = 'twilio'` routes calls through TwilioProvider

**Architecture:** From the Communication Engine's perspective, a Twilio call and a FreeSWITCH call are identical — the difference is in the Provider Layer only.

---

## Wave 10 — Analytics Platform

**Preconditions:** Wave 3 (communication_sessions), Wave 7 (ACD sessions), 12+ months of data

**Goal:** OLAP-grade analytics for enterprise reporting teams, ML-driven incident prediction, and SLA monitoring.

**New capabilities:**
- Read replica or data warehouse (Redshift/BigQuery) receiving CDC from `communication_sessions`, `ers_incident_*`, `ens_campaign_*`
- Pre-aggregated daily summary tables (materialized views or ETL)
- Dashboard builder: saved report templates, scheduled email delivery
- Anomaly detection: unusual call volume, unexpected hangup cause distribution
- SLA monitoring: ERS response time vs. configured targets, ENS delivery rate vs. thresholds

**Architecture:** Wave 10 is a parallel read path — business logic and real-time operations are unaffected. The analytics platform reads historical data only.

---

## Non-Goals (Permanent)

The following are not part of the platform vision and should not be designed for:

- **Replacing FreeSWITCH with a WebRTC-native stack** — FreeSWITCH is the voice execution backbone. WebRTC is an additional access method (browser-based agents), not a replacement.
- **Building a carrier** — The platform routes calls through SIP gateways and external carriers. It does not manage PSTN interconnects directly.
- **Consumer telephony features** (voicemail-to-text ML, social media integration) — Out of scope for an enterprise emergency notification and response system.
- **Rewriting business logic in a distributed/microservices architecture** — The monolithic Node.js backend is appropriate for the current scale and team size. Microservices would add deployment complexity with no benefit at this scale.

---

## Capability Readiness Map

Which waves enable which future products:

```
Wave 1 (Outbound Router)
  └─► Enables: Clean unit testing of ENS/ERS without FS running
  └─► Enables: Safe addition of any new origination use case

Wave 3 (Communication Engine)
  └─► Enables: Cross-module call analytics dashboard
  └─► Enables: Unified retry policy management
  └─► Enables: IVR-triggered outbound calls tracked end-to-end

Wave 4 (Provider Layer)
  └─► Enables: Wave 9 external providers
  └─► Enables: A/B testing between FreeSWITCH and Twilio for specific call types

Wave 5 (Routing Policies)
  └─► Enables: Least-cost routing for high-volume ENS blasts
  └─► Enables: International deployments with per-country carrier config
  └─► Enables: Wave 6 site-local routing

Wave 6 (Multi-Site)
  └─► Enables: Enterprise customers with global office footprint
  └─► Enables: Geographic redundancy (site failover)

Wave 7 (ACD)
  └─► Enables: Contact center module as a paid add-on tier
  └─► Enables: Integration with ERS (responder is an ACD agent)
```
