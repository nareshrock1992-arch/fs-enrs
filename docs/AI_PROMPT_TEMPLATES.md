# AI PROMPT TEMPLATES — fs-enrs

## Purpose

Standardized prompts for AI-assisted features in Phase C. All prompts are versioned and stored here. Changes require review.

---

## PT-001 — Incident Classification

**Used by**: `POST /internal/ivr/ai-intent`, ERS auto-routing

**Model**: `gpt-4o-mini` (fast, cost-effective for real-time classification)

**System prompt**:
```
You are an emergency incident classifier for an enterprise emergency response system.
Classify the caller's message into exactly one category from the allowed list.
Return ONLY valid JSON. No explanation. No markdown.
```

**User prompt template**:
```
Caller transcript: "{transcript}"
Caller extension: {extension}
Organization: {org_name}

Classify into one of: fire_emergency, medical_emergency, security_threat, 
evacuation, equipment_failure, chemical_hazard, power_outage, flood, other

Return JSON: { "intent": "<category>", "confidence": <0.0-1.0>, "summary": "<10 words max>" }
```

**Validation**: Parse JSON, validate `intent` is in allowed list, validate `confidence` is float 0-1. On failure → intent="other", confidence=0.

---

## PT-002 — Post-Incident AI Summary

**Used by**: `GET /api/v1/reports/incidents/:id/summary`

**Model**: `gpt-4o`

**System prompt**:
```
You are an emergency response incident analyst. Generate a concise, professional
post-incident summary for an enterprise emergency report. Use formal language.
Structure the output as specified. Do not include any information not provided.
```

**User prompt template**:
```
Incident ID: {incident_uuid}
Type: {incident_type}
Organization: {org_name}
Started: {started_at}
Ended: {ended_at}
Duration: {duration_minutes} minutes
Responders who joined ({responder_count}): {responder_names_list}
Call transcript: 
---
{transcript}
---

Generate a post-incident report with these sections:
1. Executive Summary (2-3 sentences)
2. Timeline of Events (bullet points with timestamps)
3. Responder Actions (who joined, when)
4. Outcome Assessment (resolved/escalated/transferred)
5. Recommendations (if any, based on response time and coverage)

Return plain text with section headers. No JSON.
```

---

## PT-003 — Speech-to-Text Transcription

**Used by**: Recording completion webhook → background job

**Service**: OpenAI Whisper API

**Request**:
```js
const transcription = await openai.audio.transcriptions.create({
  file: fs.createReadStream(recordingPath),
  model: 'whisper-1',
  language: 'en',
  response_format: 'verbose_json',  // includes word timestamps
  prompt: 'Emergency response call. Multiple speakers.'
});
```

**Post-processing**: Store `transcription.text` in `ers_incidents.transcript`. Store `transcription.segments` as JSONB in `ers_incidents.transcript_segments`.

---

## PT-004 — Responder Availability Prediction

**Used by**: Dashboard predictive panel (Phase C6)

**Model**: `gpt-4o-mini` (simple pattern analysis)

**System prompt**:
```
You are analyzing responder availability patterns for emergency response planning.
Based on historical join data, predict availability for the next period.
Return ONLY valid JSON.
```

**User prompt template**:
```
Group: {group_name}
Historical data (last 90 days):
- Monday avg join rate: {mon_pct}%
- Tuesday avg join rate: {tue_pct}%
[... all days ...]
- Hour 08-12 avg join rate: {morning_pct}%
- Hour 12-18 avg join rate: {afternoon_pct}%
- Hour 18-24 avg join rate: {evening_pct}%
- Hour 00-08 avg join rate: {night_pct}%

Current time: {current_day} {current_hour}:00

Predict availability for the next 4 hours.
Return JSON: { "predicted_availability_pct": <int>, "confidence": <0.0-1.0>, "note": "<30 words max>" }
```

---

## PT-005 — Smart Routing Recommendation

**Used by**: ERS active incident panel

**Model**: `gpt-4o-mini`

**System prompt**:
```
You are an emergency dispatch routing advisor. Recommend the best responder group
for an active incident based on availability, skills, and proximity indicators.
Be concise. Return ONLY valid JSON.
```

**User prompt template**:
```
Active incident type: {incident_type}
Organization: {org_name}
Available groups:
{groups_json}  // [{ name, member_count, available_now, avg_response_time_seconds }]

Recommend the single best group. 
Return JSON: { "recommended_group_id": <int>, "reason": "<20 words max>" }
```

---

## Prompt Engineering Rules

1. Always include `Return ONLY valid JSON` when expecting JSON output
2. Always validate and parse AI output — never trust raw string interpolation
3. Always have a fallback for when the AI call fails (timeout, error, invalid JSON)
4. Never include PII beyond what's necessary (first name + role is sufficient, not full contact record)
5. Log AI call latency and token usage to `audit_logs` with `action='ai.call'`
6. Set `max_tokens` limits: PT-001=100, PT-002=1000, PT-003=N/A, PT-004=150, PT-005=100
7. Set `temperature=0` for classification (PT-001, PT-005) — deterministic output required
8. Set `temperature=0.3` for summaries (PT-002) — slight creativity acceptable
