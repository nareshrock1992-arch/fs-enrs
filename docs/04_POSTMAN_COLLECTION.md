# 04 — Postman Collection

## Import Instructions

The JSON below is a Postman v2.1 collection. To import:

1. Open Postman → **Import** → **Raw text**
2. Paste the JSON below
3. Click **Import**

Set the collection variable `base_url` to `http://localhost:4100/api/v1` and `internal_key` to your `INTERNAL_API_KEY` value.

After importing, run the **Login** request first — the collection uses a `postman-pre-request` script to extract and store the JWT token automatically.

---

## Collection Variables

| Variable | Example Value | Description |
|---|---|---|
| `base_url` | `http://localhost:4100/api/v1` | Backend API base |
| `internal_base` | `http://localhost:4100/api/v1/internal` | Internal API base |
| `token` | *(auto-set by Login request)* | JWT access token |
| `internal_key` | `your-internal-api-key` | `X-Internal-Key` header value |
| `tenant_id` | *(from login response)* | Current tenant UUID |

---

## Postman Collection JSON

```json
{
  "info": {
    "name": "FS-ENRS API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    "_postman_id": "fs-enrs-2026"
  },
  "variable": [
    { "key": "base_url", "value": "http://localhost:4100/api/v1" },
    { "key": "internal_base", "value": "http://localhost:4100/api/v1/internal" },
    { "key": "token", "value": "" },
    { "key": "internal_key", "value": "your-internal-api-key" }
  ],
  "auth": {
    "type": "bearer",
    "bearer": [{ "key": "token", "value": "{{token}}", "type": "string" }]
  },
  "item": [
    {
      "name": "Auth",
      "item": [
        {
          "name": "Login",
          "event": [{
            "listen": "test",
            "script": {
              "exec": [
                "const json = pm.response.json();",
                "if (json.token) pm.collectionVariables.set('token', json.token);"
              ]
            }
          }],
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\"email\": \"admin@enrs.local\", \"password\": \"Admin@12345\"}"
            },
            "url": "{{base_url}}/auth/login"
          }
        },
        {
          "name": "Refresh Token",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/auth/refresh"
          }
        },
        {
          "name": "Me",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/auth/me"
          }
        },
        {
          "name": "Logout",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/auth/logout"
          }
        }
      ]
    },
    {
      "name": "ERS Configurations",
      "item": [
        {
          "name": "List ERS Configs",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/ers/configurations"
          }
        },
        {
          "name": "Create ERS Config",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"Main Gate ERS\",\n  \"primary_bridge_number\": \"3010\",\n  \"secondary_bridge_number\": \"3011\",\n  \"conference_profile\": \"default\",\n  \"conference_type\": \"STATIC\",\n  \"max_concurrent_conferences\": 2,\n  \"queue_enabled\": true,\n  \"recording_enabled\": false,\n  \"recording_mode\": \"MANUAL\",\n  \"recording_trigger\": \"CONFERENCE_CREATED\",\n  \"recording_format\": \"wav\"\n}"
            },
            "url": "{{base_url}}/ers/configurations"
          }
        },
        {
          "name": "Get ERS Config",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/ers/configurations/1"
          }
        },
        {
          "name": "Update ERS Config",
          "request": {
            "method": "PUT",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"Main Gate ERS Updated\",\n  \"recording_enabled\": true,\n  \"recording_mode\": \"AUTO\",\n  \"recording_trigger\": \"FIRST_PARTICIPANT\"\n}"
            },
            "url": "{{base_url}}/ers/configurations/1"
          }
        },
        {
          "name": "Toggle Active",
          "request": {
            "method": "PATCH",
            "url": "{{base_url}}/ers/configurations/1/toggle"
          }
        },
        {
          "name": "Get Tier Groups",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/ers/configurations/1/tier-groups"
          }
        },
        {
          "name": "Update Tier Groups",
          "request": {
            "method": "PUT",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"primary_group_ids\": [1],\n  \"secondary_group_ids\": [],\n  \"primary_contact_ids\": [1, 2],\n  \"secondary_contact_ids\": []\n}"
            },
            "url": "{{base_url}}/ers/configurations/1/tier-groups"
          }
        }
      ]
    },
    {
      "name": "ERS Incidents",
      "item": [
        {
          "name": "List Incidents",
          "request": {
            "method": "GET",
            "url": {
              "raw": "{{base_url}}/ers/incidents",
              "query": [
                { "key": "status", "value": "ACTIVE", "disabled": true },
                { "key": "configuration_id", "value": "1", "disabled": true }
              ]
            }
          }
        },
        {
          "name": "Incident Detail",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/ers/incidents/{{incident_uuid}}/detail"
          }
        },
        {
          "name": "Complete Incident",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/ers/incidents/{{incident_uuid}}/complete"
          }
        }
      ]
    },
    {
      "name": "ENS Configurations",
      "item": [
        {
          "name": "List ENS Configs",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/ens/configurations"
          }
        },
        {
          "name": "Create ENS Config",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"name\": \"Building A ENS\",\n  \"pin\": \"1234\",\n  \"no_pending_msg\": \"No active broadcasts at this time.\",\n  \"expiry_announcement\": \"This broadcast has expired.\",\n  \"contact_ids\": [],\n  \"group_ids\": []\n}"
            },
            "url": "{{base_url}}/ens/configurations"
          }
        }
      ]
    },
    {
      "name": "Monitoring",
      "item": [
        {
          "name": "List Conferences",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/monitoring/conferences"
          }
        },
        {
          "name": "ESL Status",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/monitoring/status"
          }
        },
        {
          "name": "Lock Conference",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/monitoring/conferences/3010/lock"
          }
        },
        {
          "name": "Start Recording",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\"path\": \"/var/lib/freeswitch/recordings/ers/manual_3010.wav\"}"
            },
            "url": "{{base_url}}/monitoring/conferences/3010/record/start"
          }
        },
        {
          "name": "Mute Member",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/monitoring/conferences/3010/members/1/mute"
          }
        },
        {
          "name": "Kick Member",
          "request": {
            "method": "DELETE",
            "url": "{{base_url}}/monitoring/conferences/3010/members/1"
          }
        }
      ]
    },
    {
      "name": "Deployment",
      "item": [
        {
          "name": "Diagnostics",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/deployment/diagnostics"
          }
        },
        {
          "name": "FS Paths",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/deployment/diagnostics/paths"
          }
        },
        {
          "name": "Reload XML",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/deployment/diagnostics/reloadxml"
          }
        },
        {
          "name": "List Flow Deployments",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/deployment/flows"
          }
        }
      ]
    },
    {
      "name": "Internal — ERS (Lua Contract)",
      "item": [
        {
          "name": "ERS Lookup",
          "request": {
            "auth": { "type": "noauth" },
            "method": "GET",
            "header": [{ "key": "X-Internal-Key", "value": "{{internal_key}}" }],
            "url": {
              "raw": "{{internal_base}}/ers/lookup?number=1222",
              "query": [{ "key": "number", "value": "1222" }]
            }
          }
        },
        {
          "name": "Create ERS Incident",
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "X-Internal-Key", "value": "{{internal_key}}" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"configuration_id\": 1,\n  \"caller_number\": \"7001003\",\n  \"conference_room\": \"3010\",\n  \"group_type\": \"primary\",\n  \"status\": \"ACTIVE\"\n}"
            },
            "url": "{{internal_base}}/ers/incidents"
          }
        },
        {
          "name": "Ring All",
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "X-Internal-Key", "value": "{{internal_key}}" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"configuration_id\": 1,\n  \"caller_number\": \"7001003\",\n  \"tier\": \"primary\"\n}"
            },
            "url": "{{internal_base}}/ers/ring-all"
          }
        },
        {
          "name": "Complete Incident",
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "X-Internal-Key", "value": "{{internal_key}}" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\"recording_file\": \"/var/lib/freeswitch/recordings/ers/3010.wav\"}"
            },
            "url": "{{internal_base}}/ers/incidents/{{incident_uuid}}/complete"
          }
        }
      ]
    },
    {
      "name": "Internal — ENS (Lua Contract)",
      "item": [
        {
          "name": "ENS Lookup",
          "request": {
            "auth": { "type": "noauth" },
            "method": "GET",
            "header": [{ "key": "X-Internal-Key", "value": "{{internal_key}}" }],
            "url": {
              "raw": "{{internal_base}}/ens/lookup?number=1333",
              "query": [{ "key": "number", "value": "1333" }]
            }
          }
        },
        {
          "name": "Verify PIN",
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "X-Internal-Key", "value": "{{internal_key}}" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\"configuration_id\": 1, \"pin\": \"1234\"}"
            },
            "url": "{{internal_base}}/ens/verify-pin"
          }
        },
        {
          "name": "Start Campaign",
          "request": {
            "auth": { "type": "noauth" },
            "method": "POST",
            "header": [
              { "key": "Content-Type", "value": "application/json" },
              { "key": "X-Internal-Key", "value": "{{internal_key}}" }
            ],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"configuration_id\": 1,\n  \"recording_file\": \"/var/lib/freeswitch/recordings/ens/msg.wav\",\n  \"caller_number\": \"7001001\"\n}"
            },
            "url": "{{internal_base}}/ens/campaign/start"
          }
        }
      ]
    },
    {
      "name": "Service Registry",
      "item": [
        {
          "name": "List Services",
          "request": {
            "method": "GET",
            "url": "{{base_url}}/services"
          }
        },
        {
          "name": "Create Service Binding",
          "request": {
            "method": "POST",
            "header": [{ "key": "Content-Type", "value": "application/json" }],
            "body": {
              "mode": "raw",
              "raw": "{\n  \"number\": \"1222\",\n  \"type\": \"ERS\",\n  \"description\": \"Main Gate Emergency\",\n  \"ers_configuration_id\": 1,\n  \"is_active\": true\n}"
            },
            "url": "{{base_url}}/services"
          }
        }
      ]
    },
    {
      "name": "Health",
      "item": [
        {
          "name": "Health Check",
          "request": {
            "auth": { "type": "noauth" },
            "method": "GET",
            "url": "http://localhost:4100/api/health"
          }
        }
      ]
    }
  ]
}
```
