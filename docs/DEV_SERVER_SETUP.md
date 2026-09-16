# FS-ENRS — Development Server Setup & Runtime Standardization

> **Golden rule:** on a development server, FS-ENRS runs from the **local checked-out
> source repository** at `/opt/freeswitch-ui/fs-enrs` — **never** from a Docker
> image/container. Docker config lives in the repo for *production/containerized*
> deployment only and must never silently become the dev runtime.
>
> Verify with `scripts/dev-runtime-identity.sh` and `scripts/dev-preflight.sh`.

This is the authoritative guide for standing up (and validating) a new FS-ENRS
**source-development** server. Values below are the verified defaults from the
current dev host (`freeswitch`, Tailscale `100.93.232.116`).

---

## A. Architecture

### Source development (DEFAULT — what this guide sets up)

```
Browser
   │
   ▼
Vite / Frontend SOURCE            /opt/freeswitch-ui/fs-enrs/frontend      (:8100)
   │  (dev proxy /api → :4100)
   ▼
Node.js / Backend SOURCE          /opt/freeswitch-ui/fs-enrs/backend       (:4100, PM2)
   ├──► PostgreSQL                127.0.0.1:5432   (host service)
   ├──► Piper HOST SERVICE        127.0.0.1:5001   (systemd piper-tts)
   └──► FreeSWITCH HOST SERVICE   127.0.0.1:8021   (systemd, ESL)
                                     ▲
                                     └── Lua scripts call Piper at PIPER_LUA_URL (127.0.0.1:5001)
```

Everything above runs directly from the checked-out repo. No container is involved.

### Docker / container deployment (SEPARATE — not the dev default)

```
Browser → Docker app (backend/frontend containers)
             ├──► Docker PostgreSQL   (service name: postgres)
             ├──► Docker Piper        (service name: piper, container port 5000)
             └──► FreeSWITCH (external / host, defined separately)
```

> ⚠️ **Docker configuration is NOT the default runtime for source development.**
> Docker service names (`piper`, `postgres`, `redis`) and container-internal ports
> (e.g. Piper `5000`) are only valid *inside* the Docker network. They must never
> be copied into the host `backend/.env`.

---

## B. Source development vs Docker

| Area                     | Source Development (this host)        | Docker deployment            |
| ------------------------ | ------------------------------------- | ---------------------------- |
| FS-ENRS backend          | Local repo (`backend/server.js`, PM2) | Container                    |
| Frontend                 | Local repo (Vite)                     | Container                    |
| Piper                    | Host / `systemd piper-tts`            | Docker service               |
| Piper hostname           | `127.0.0.1`                           | `piper`                      |
| Piper port               | `5001` (host)                         | `5000` (container-internal)  |
| FreeSWITCH               | Host / systemd                        | External / defined separately|
| PostgreSQL               | Host `127.0.0.1:5432`                 | Docker service `postgres`    |
| PM2                      | Yes                                   | No (container entrypoint)    |
| Normal developer startup | **Source** (`fs-dev-all.sh`)          | **NOT Docker**               |

---

## C. Configuration matrix (Piper / DB / ESL)

| Variable            | Source-dev value            | Docker value            | Consumer                          | Notes |
| ------------------- | --------------------------- | ----------------------- | --------------------------------- | ----- |
| `PIPER_BACKEND_URL` | `http://127.0.0.1:5001`     | `http://piper:5000`     | Node backend (`piperClient`)      | **Host = 5001.** Docker DNS `piper:5000` fails from the host. |
| `PIPER_LUA_URL`     | `http://127.0.0.1:5001`     | `http://127.0.0.1:5001` | FreeSWITCH Lua / `deploymentEngine` | Host-loopback both ways (FreeSWITCH runs on the host). |
| `PIPER_HOST_PORT`   | `5001`                      | `5001`                  | Docker publish → host loopback    | The host port Piper answers on. |
| `PIPER_SAMPLE_RATE` | `8000`                      | `8000`                  | Piper service (resample target)   | Piper model native 22050 Hz → sox → 8000 Hz mono PCM. |
| `PORT`              | `4100`                      | `4100`                  | Node backend HTTP                 | |
| `DB_HOST`/`DB_PORT` | `127.0.0.1` / `5432`        | `postgres` / `5432`     | Node backend                      | Never use `postgres` on the host. |
| `ESL_HOST`/`ESL_PORT`| `127.0.0.1` / `8021`       | (host/gateway)          | Node backend (ESL)                | FreeSWITCH ESL binds host loopback by default. |

Classify every value before editing: **DOCKER ONLY / SOURCE DEV / PRODUCTION /
SHARED / AMBIGUOUS**. Never fix host development by editing production/Docker
config, and never copy a Docker value into `backend/.env`.

---

## D. New Debian development server — installation

> Use placeholders for any private URLs/credentials. Do not commit secrets.

### Step 1 — OS prerequisites
```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential sox libsndfile1 \
     python3 python3-venv python3-pip
# Node.js 20+ (repo runs on Node 20/24). Install via your standard method (nvm/nodesource).
npm install -g pm2
```

### Step 2 — FreeSWITCH (host / systemd)
- Install FreeSWITCH (custom build at `/opt/freeswitch/` on the current host).
- Enable `mod_event_socket`; ESL listens on `127.0.0.1:8021` (password managed in
  `event_socket.conf.xml`; change from the public default before any exposure).
- Run as a systemd unit (`systemctl enable --now freeswitch`).
- FreeSWITCH must be able to reach Piper for Lua prompts — see Step 4 note.

### Step 3 — PostgreSQL (host)
```bash
sudo apt-get install -y postgresql
sudo -u postgres createuser fs_enrs --pwprompt        # set a strong password (placeholder)
sudo -u postgres createdb  fs_enrs -O fs_enrs
```
Migrations are applied automatically by the backend on start (`runMigrations()`),
or manually: `cd backend && node src/db/migrate.js`.

### Step 4 — Piper (host / systemd)
```bash
cd /opt/freeswitch-ui/fs-enrs/services/piper
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt          # fastapi, uvicorn, piper-tts, soundfile
# Voice model (≈63 MB) + config into the model dir:
sudo mkdir -p /opt/piper/models
#   en_US-lessac-medium.onnx  +  en_US-lessac-medium.onnx.json   (native 22050 Hz)
```
Install the systemd unit (server-local, NOT in git) `/etc/systemd/system/piper-tts.service`:
```ini
[Unit]
Description=Piper TTS HTTP Service for ENRS
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/freeswitch-ui/fs-enrs/services/piper
Environment=PIPER_MODEL_DIR=/opt/piper/models
Environment=PIPER_DEFAULT_VOICE=en_US-lessac-medium
Environment=PIPER_SAMPLE_RATE=8000
Environment=PIPER_MAX_CONCURRENT=2
ExecStart=/opt/freeswitch-ui/fs-enrs/services/piper/.venv/bin/uvicorn src.server:app --host 0.0.0.0 --port 5001 --workers 1
Restart=always
RestartSec=5
StandardOutput=append:/var/log/piper/piper.log
StandardError=append:/var/log/piper/piper.log
[Install]
WantedBy=multi-user.target
```
```bash
sudo mkdir -p /var/log/piper
sudo systemctl daemon-reload && sudo systemctl enable --now piper-tts
curl -s http://127.0.0.1:5001/health        # → {"status":"ok"}
```
> **Port must match `PIPER_BACKEND_URL` and `PIPER_LUA_URL` (both `…:5001`).**
> **FreeSWITCH Lua note:** the hand-written Lua (`ens_blast_trigger.lua`,
> `ens_playback_handler.lua`) read `os.getenv("PIPER_LUA_URL")`, so FreeSWITCH's
> *own* process environment must define it. Add a drop-in
> `/etc/systemd/system/freeswitch.service.d/piper-env.conf` with
> `Environment=PIPER_LUA_URL=http://127.0.0.1:5001` and restart FreeSWITCH, OR rely
> on `deploymentEngine` embedding the URL into generated Lua for IVR nodes.

### Step 5 — FS-ENRS repository
```bash
sudo mkdir -p /opt/freeswitch-ui
cd /opt/freeswitch-ui
git clone <PRIVATE_REPO_URL> fs-enrs
cd /opt/freeswitch-ui/fs-enrs
git checkout main
```

### Step 6 — Backend (source, PM2)
```bash
cd /opt/freeswitch-ui/fs-enrs/backend
npm install
# Create backend/.env for HOST dev (NOT Docker values):
#   PORT=4100
#   DB_HOST=127.0.0.1  DB_PORT=5432  DB_NAME=fs_enrs  DB_USER=fs_enrs  DB_PASSWORD=<placeholder>
#   ESL_HOST=127.0.0.1  ESL_PORT=8021  ESL_PASSWORD=<placeholder>
#   PIPER_BACKEND_URL=http://127.0.0.1:5001
#   PIPER_LUA_URL=http://127.0.0.1:5001
#   PIPER_HOST_PORT=5001  PIPER_SAMPLE_RATE=8000  PIPER_DEFAULT_VOICE=en_US-lessac-medium
pm2 start ecosystem.config.cjs --env development     # cwd is pinned to this dir
pm2 save
curl -s http://127.0.0.1:4100/api/health/ready 2>/dev/null || curl -s http://127.0.0.1:4100/api/health
```

### Step 7 — Frontend (source, Vite)
```bash
cd /opt/freeswitch-ui/fs-enrs/frontend
npm install
# Optional frontend/.env: VITE_BACKEND_DEV_URL=http://localhost:4100  VITE_DEV_PORT=8100
npm run dev -- --host 0.0.0.0 --port 8100            # dev proxy forwards /api → :4100
```
(Or use the lifecycle manager: `./fs-dev-all.sh` — it starts backend via PM2 +
frontend via Vite from source; it does **not** use Docker.)

### Step 8 — Validation
```bash
scripts/dev-runtime-identity.sh     # confirms SOURCE mode + shows every runtime
scripts/dev-preflight.sh            # read-only PASS/FAIL gate (backend→Piper, ESL, DB, no app containers)
# Direct Piper synthesis (should return 8000 Hz mono PCM):
curl -s -X POST http://127.0.0.1:5001/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"Piper diagnostic","voice":"en_US-lessac-medium"}' -o /tmp/t.wav && soxi /tmp/t.wav && rm -f /tmp/t.wav
```

---

## E. DO NOT DO THIS

```
1.  Run FS-ENRS from a Docker image during normal source development.
2.  Copy the Docker value PIPER_BACKEND_URL=http://piper:5000 into backend/.env.
3.  Assume piper:5000 works from the host — the host has no "piper" DNS; use 127.0.0.1:5001.
4.  Start an old container and assume it represents the current source.
5.  Test functionality against a stale Docker image (e.g. fs-cc-backend:latest).
6.  Run the backend from another checkout or a copied build directory.
7.  Run an old compiled/build (dist/) directory as the runtime.
8.  Change production/Docker configuration to fix host development.
9.  Delete containers/images/volumes as "troubleshooting" without authorization.
10. Rebuild Docker images unless Docker DEPLOYMENT testing is explicitly requested.
```

---

## F. Runtime identity & preflight (prove you're on source)

- **`scripts/dev-runtime-identity.sh`** — read-only snapshot: source root, git
  branch/commit, backend/frontend/Piper/FreeSWITCH PIDs + working dirs, and whether
  any FS-ENRS *application* container is running. Ends with
  `SOURCE DEVELOPMENT MODE: VERIFIED` (or NOT).
- **`scripts/dev-preflight.sh`** — read-only PASS/FAIL gate; exits non-zero if the
  backend isn't running from the repo, an app container is serving the app, Piper
  isn't reachable on `PIPER_BACKEND_URL`, ESL/DB are unreachable, or
  `PIPER_BACKEND_URL` uses a Docker service name.

Both scripts modify nothing. Run either before testing TTS/ENS/IVR/campaign flows.

---

## G. Default development mode (canonical statement)

```
========================================
FS-ENRS DEFAULT DEVELOPMENT MODE
========================================
LOCAL CHECKED-OUT SOURCE REPOSITORY
/opt/freeswitch-ui/fs-enrs
Backend:     SOURCE
Frontend:    SOURCE
Piper:       HOST SERVICE (127.0.0.1:5001)
FreeSWITCH:  HOST SERVICE (ESL 127.0.0.1:8021)
Docker:      NOT USED FOR FS-ENRS APPLICATION RUNTIME
========================================
```
