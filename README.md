# Satisfactory Command Center

Self-hosted Satisfactory Dedicated Server plus a web dashboard, deployable with Docker Compose.

The project runs two containers:

- `satisfactory-server`: the actual Satisfactory Dedicated Server, based on `wolveix/satisfactory-server`
- `satisfactory-dashboard`: a React/Node dashboard for auth, status, saves, resource usage, map data, and updates

## Features

- One-command Docker Compose deployment
- Password-protected web dashboard
- Server start, stop, and restart controls
- CPU, memory, process, and network usage from Docker
- World state from the Satisfactory Dedicated Server API
- Connected player count, world runtime, tick rate, tech tier, game phase, and session name
- Savegame listing, manual save, upload, download, and load actions
- Update check and confirmation flow for the server Docker image
- Optional live player locations via Ficsit Remote Monitoring
- Fallback map positions from the latest local `.sav` file

## Requirements

- Docker Engine or Docker Desktop
- Docker Compose v2
- At least 8 GB RAM available for the Satisfactory server
- Ports available on the host:
  - no dashboard host port is published by default; Coolify should route the domain to container port `80`
  - `7777/tcp` and `7777/udp` for the game server by default, configurable with `SATISFACTORY_GAME_*`
  - `8888/tcp` for reliable messaging by default, configurable with `SATISFACTORY_MESSAGING_HOST_PORT`

## Quick Start

Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Edit `.env` before starting:

```env
WEB_ADMIN_PASSWORD=use-a-real-password
JWT_SECRET=use-a-long-random-secret
DASHBOARD_CONTAINER_PORT=80
MAXPLAYERS=4
```

The dashboard container listens on port `80`. In Coolify, assign your dashboard domain to the `dashboard` service instead of publishing host port `80`.

```env
DASHBOARD_CONTAINER_PORT=80
SERVICE_FQDN_DASHBOARD=dash.example.com
```

Start everything:

```bash
docker compose up -d --build
```

Open the dashboard:

Use the domain configured in Coolify, for example `https://dash.example.com`.

Log in with `WEB_ADMIN_PASSWORD`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEB_ADMIN_PASSWORD` | `change-me-now` | Password for the dashboard login |
| `JWT_SECRET` | `replace-with-a-long-random-string` | Secret used to sign dashboard sessions |
| `DASHBOARD_CONTAINER_PORT` | `80` | Internal port the dashboard container listens on |
| `DASHBOARD_DEV_API_PORT` | `8080` | Local development backend port |
| `DASHBOARD_MEMORY_LIMIT` | `768m` | Docker memory limit for the dashboard container |
| `SATISFACTORY_CONTAINER_NAME` | `satisfactory-server` | Container controlled by the dashboard |
| `SATISFACTORY_SERVICE_NAME` | `satisfactory-server` | Compose service name used to find Coolify-renamed containers |
| `SATISFACTORY_IMAGE` | `wolveix/satisfactory-server:latest` | Docker image checked and pulled by the update flow |
| `SATISFACTORY_HOST_IP` | `0.0.0.0` | Host interface used for Satisfactory port bindings |
| `SATISFACTORY_GAME_TCP_HOST_PORT` | `7777` | Host TCP game/API port |
| `SATISFACTORY_GAME_UDP_HOST_PORT` | `7777` | Host UDP game port |
| `SATISFACTORY_MESSAGING_HOST_PORT` | `8888` | Host reliable messaging port |
| `SERVERGAMEPORT` | `7777` | Internal Satisfactory game/API port used by the server image |
| `SERVERMESSAGINGPORT` | `8888` | Internal reliable messaging port used by the server image |
| `SATISFACTORY_API_PROTOCOL` | `https` | Protocol used by the dashboard to call the Dedicated Server API |
| `SATISFACTORY_API_HOST` | `satisfactory-server` | Hostname used by the dashboard to call the Dedicated Server API |
| `SATISFACTORY_API_PORT` | `7777` | Port used by the dashboard to call the Dedicated Server API |
| `SATISFACTORY_API_URL` | empty | Optional full API URL override. If `/api/v1` is missing, the dashboard appends it |
| `SATISFACTORY_API_TOKEN` | empty | Preferred auth method for admin API actions |
| `SATISFACTORY_ADMIN_PASSWORD` | empty | Alternative auth method for admin API actions |
| `FRM_BASE_URL` | empty | Optional Ficsit Remote Monitoring base URL for live player positions |
| `ENABLE_SAVE_MAP_PARSING` | `false` | Enables local `.sav` parsing for map fallback |
| `MAX_SAVE_PARSE_BYTES` | `104857600` | Maximum save size parsed by the dashboard |
| `MAXPLAYERS` | `4` | Satisfactory max player count |
| `PUID` | `1000` | User id used by the server container |
| `PGID` | `1000` | Group id used by the server container |
| `STEAMBETA` | `false` | Enables beta branch behavior in the server image |
| `SKIPUPDATE` | `false` | Skips SteamCMD update checks inside the server container |

## Data Layout

Persistent data is stored under `./data`:

```text
data/
  satisfactory-server/   Satisfactory server config and saves
  dashboard/             Dashboard settings and local logs
```

The dashboard mounts `./data/satisfactory-server` read-only so it can parse local saves for map fallback data.

The UI uses a local copy of the Satisfactory world map at `public/assets/satisfactory-map.jpg`. The source is the Official Satisfactory Wiki `Map.jpg`; Satisfactory assets are owned by Coffee Stain Studios.

## Server API Auth

The dashboard can show basic Docker health without Satisfactory API admin auth, but save management and some server API calls need admin credentials.

Preferred setup:

1. Start the server once.
2. Claim/configure the server in Satisfactory or through the dedicated server console.
3. Generate an API token:

```text
server.GenerateAPIToken
```

4. Put the token in `.env`:

```env
SATISFACTORY_API_TOKEN=your-token-here
```

You can also enter the token or admin password in the dashboard settings. Values entered there are stored in `data/dashboard/settings.json`.

## Live Map And Player Positions

The vanilla Satisfactory Dedicated Server API does not expose live player coordinates. This dashboard supports two data sources:

- Live mode: set `FRM_BASE_URL` to a reachable Ficsit Remote Monitoring endpoint. The dashboard calls `GET /getPlayer`.
- Save fallback: if `ENABLE_SAVE_MAP_PARSING=true`, the dashboard parses the newest `.sav` file from the mounted server data.

Example:

```env
FRM_BASE_URL=http://satisfactory-server:8080
```

Save fallback is useful for overview and offline inspection, but it can use a lot of memory on large worlds. It is disabled by default so the dashboard cannot crash-loop from save parsing on small VPS instances. Prefer FRM for live positions.

## Updates

The dashboard update button:

1. Checks the remote Docker image digest for `SATISFACTORY_IMAGE`.
2. Shows a confirmation dialog.
3. Attempts to create a pre-update save through the Satisfactory API.
4. Pulls the latest Docker image.
5. Restarts the Satisfactory server container.

The `wolveix/satisfactory-server` image also checks for game server updates through SteamCMD on container startup unless `SKIPUPDATE=true`.

## Save Management

From the dashboard you can:

- List sessions/saves from the server API
- Trigger a manual save
- Upload a `.sav`
- Download a save
- Load a save

Admin API auth must be configured for these actions.

## Local Development

Install dependencies:

```bash
npm install
```

Run the backend and Vite dev server:

```bash
npm run dev
```

Useful scripts:

```bash
npm run lint
npm run build
npm start
```

During local development:

- Node API: `http://localhost:8080`
- Vite frontend: `http://localhost:5173`

## Coolify Deployment

Coolify creates its own runtime `.env` file. It does not automatically use `.env.example`.

Do not publish host port `80` or `443` for the dashboard in Coolify. Those ports are already used by the Coolify proxy. The dashboard should only expose container port `80`; the domain routes through Coolify.

The values that matter are:

```env
DASHBOARD_CONTAINER_PORT=80
DASHBOARD_MEMORY_LIMIT=768m
SERVICE_FQDN_DASHBOARD=dash.bolte.lol
```

For your Satisfactory API connection, either leave `SATISFACTORY_API_URL` empty and use protocol/host/port:

```env
SATISFACTORY_API_PROTOCOL=https
SATISFACTORY_API_HOST=satisfactory-server
SATISFACTORY_API_PORT=7777
SATISFACTORY_API_URL=
```

or set the full URL with the API path:

```env
SATISFACTORY_API_URL=https://satisfactory-server:7777/api/v1
```

Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` in Coolify. The dashboard already accepts the Satisfactory server's self-signed certificate only for the Satisfactory API request.

## Security Notes

The dashboard container mounts `/var/run/docker.sock` so it can read stats, restart the Satisfactory server, and pull updates. That is powerful access to the host Docker daemon.

For a real server:

- Change `WEB_ADMIN_PASSWORD`
- Change `JWT_SECRET`
- Do not expose the dashboard port directly to the public internet
- Put the dashboard behind a VPN, reverse proxy auth, or a trusted private network
- Use HTTPS if accessed outside localhost/LAN
- Keep backups of `data/satisfactory-server`

## Troubleshooting

Check container status:

```bash
docker compose ps
```

View dashboard logs:

```bash
docker compose logs -f dashboard
```

View Satisfactory server logs:

```bash
docker compose logs -f satisfactory-server
```

Rebuild the dashboard:

```bash
docker compose up -d --build dashboard
```

Restart the game server:

```bash
docker compose restart satisfactory-server
```

If the dashboard loads but save actions fail, check that `SATISFACTORY_API_TOKEN` or `SATISFACTORY_ADMIN_PASSWORD` is set.

If live player positions do not appear, check `FRM_BASE_URL`. Without FRM, the map only updates when a new save exists.

## Known Limitations

- Live coordinates require Ficsit Remote Monitoring or another API that exposes player positions.
- Save parsing is a fallback and may lag behind active gameplay.
- Docker update checks depend on access to Docker Hub.
- The dashboard is designed for self-hosted/private deployment, not public multi-tenant hosting.
