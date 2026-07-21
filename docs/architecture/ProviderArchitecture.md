# Provider Architecture

**ENRS Unified Communications Platform**  
Version 1.0 · 2026-07-21 · Implementation: Wave 4

---

## Purpose

The Provider Layer translates provider-agnostic `CallInstruction` objects into the protocol of a specific execution backend (FreeSWITCH ESL, Twilio REST, SBC API, WebRTC). The Layer also translates incoming provider events into standard `CallEvents` that the Communication Engine understands.

After Wave 4, replacing or adding a provider requires only a new file in `src/providers/`. No business module, routing, or session tracking code changes.

---

## Provider Interface

Every provider must implement this contract:

```javascript
class Provider {
  // Unique identifier — matches sip_gateways.provider column value
  get id() { throw new Error('abstract'); }

  // Can this provider currently accept calls?
  async isAvailable() { return true; }

  // Place an outbound call.
  // Returns: { providerSessionId }
  // providerSessionId is stored in communication_sessions.provider_session_id
  async placeCall({
    sessionUuid,        // platform UUID — set as channel variable enrs_session_uuid
    dialString,         // already resolved by Outbound Router
    callerIdNumber,     // already selected by Outbound Router
    callerIdName,       // already sanitized by Outbound Router
    action,             // 'playback' | 'conference' | 'park' | 'transfer'
    actionTarget,       // file path, room name, transfer target
    conferenceProfile,  // FS profile name (for action='conference')
    timeoutSeconds,
    async,              // true = non-blocking (bgapi), false = blocking
    extraVars,          // additional channel variables
  }) { throw new Error('abstract'); }

  // Terminate an active call
  async hangup(providerSessionId) { throw new Error('abstract'); }

  // Subscribe to standard call events
  // Standard events: 'answer' | 'hangup' | 'ringing' | 'dtmf' | 'media'
  on(event, handler) { throw new Error('abstract'); }
}
```

---

## FreeSWITCH Provider

`src/providers/freeswitchProvider.js` wraps the existing `eslService.js`. The ESL service continues to manage the connection, event subscription, and conference tracking — the provider just translates.

```javascript
class FreeSwitchProvider extends Provider {
  get id() { return 'freeswitch'; }

  async placeCall({ sessionUuid, dialString, callerIdNumber, callerIdName,
                    action, actionTarget, conferenceProfile, timeoutSeconds,
                    extraVars, async: isAsync }) {

    // ALL channel variable assembly is here — the only place in the codebase
    const varBlock = buildVarBlock({
      origination_caller_id_number: callerIdNumber,
      origination_caller_id_name:   callerIdName,
      effective_caller_id_number:   callerIdNumber,
      effective_caller_id_name:     callerIdName,
      ignore_early_media:           'true',
      originate_timeout:            String(timeoutSeconds ?? 30),
      enrs_session_uuid:            sessionUuid,
      ...extraVars,
    });

    const app = buildApp(action, actionTarget, conferenceProfile);
    const cmd = `${isAsync ? 'bgapi ' : ''}originate {${varBlock}}${dialString} ${app}`;
    const result = await eslCommand(cmd);

    return { providerSessionId: extractFsUuid(result) };
  }

  async hangup(fsUuid) {
    await eslCommand(`api uuid_kill ${fsUuid}`);
  }

  on(event, handler) {
    eslEventBus.on(event, handler);
  }
}
```

### FreeSWITCH Standard Event Translation

```
CHANNEL_ANSWER  → 'answer'  (providerSessionId = channel UUID)
CHANNEL_HANGUP  → 'hangup'  (providerSessionId, hangupCause → standard code)
CHANNEL_RINGING → 'ringing'
DTMF            → 'dtmf'    (digit)
```

Hangup cause translation uses `hangupCodeNormalizer.js` (Wave 3) to convert FS-specific cause strings to standard disconnect codes.

---

## Provider Registry

```javascript
// src/providers/providerRegistry.js
const registry = new Map([
  ['freeswitch', new FreeSwitchProvider()],
  // ['twilio',     new TwilioProvider()],    // future
  // ['vonage',     new VonageProvider()],    // future
]);

export function getProvider(id = 'freeswitch') {
  const p = registry.get(id);
  if (!p) throw new Error(`Unknown provider: ${id}`);
  return p;
}
```

The `sip_gateways.provider` column (added Wave 1, `DEFAULT 'freeswitch'`) tells the Outbound Router which provider to use for calls through a given gateway.

---

## Gateway-to-Provider Mapping

```
sip_gateways row:
  name:     "uk-pstn-primary"
  provider: "freeswitch"   ← selects FreeSwitchProvider
  host:     "sip.carrier.uk"
  ...

Future row:
  name:     "twilio-us"
  provider: "twilio"       ← selects TwilioProvider (when implemented)
  host:     "api.twilio.com"
  ...
```

---

## Future Providers (Design Only)

### Twilio

```javascript
class TwilioProvider extends Provider {
  get id() { return 'twilio'; }

  async placeCall({ sessionUuid, dialString, callerIdNumber, action, actionTarget }) {
    const call = await twilioClient.calls.create({
      to:   dialString,          // already E.164 (normalizer prepared it)
      from: callerIdNumber,
      url:  `${webhookBase}/twiml/${sessionUuid}`,
    });
    return { providerSessionId: call.sid };
  }
}
// Twilio events arrive via webhook → standard CallEvent translation
```

### SBC Integration

An SBC (Session Border Controller) provider bridges to Avaya, Cisco, or PSTN via SIP INVITE. The provider sends a SIP INVITE to the SBC; the SBC handles carrier termination. From the platform's perspective it is a REST or SIP-over-WebSocket call.

### Remote FreeSWITCH Cluster (Wave 6)

Multiple FreeSWITCH instances (one per site) each have their own ESL connection. The FreeSWITCH Provider becomes a pool:

```javascript
class FreeSwitchProvider extends Provider {
  // Pool keyed by site_id
  connections = new Map();   // site_id → ESL connection

  async placeCall({ sessionUuid, dialString, siteId, ...rest }) {
    const conn = this.connections.get(siteId ?? 'default');
    // ... same logic as single-instance provider
  }
}
```

Business modules are unaffected — they pass an optional `preferredSiteId` hint in the CommunicationRequest; the Engine/Router passes it through to the provider.

---

## What Providers Are Forbidden To Know

- Which business module originated the call (module, moduleRefId)
- Communication Session lifecycle
- Routing decisions (gateway was already selected by Router)
- Retry policy
- Business-level status (DELIVERED, INCIDENT_ACTIVE, etc.)

Providers know: dial strings, channel variables, and standard events. Nothing else.
