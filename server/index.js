import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import Docker from 'dockerode';
import express from 'express';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import rateLimit from 'express-rate-limit';
import { Agent } from 'undici';
import { fileURLToPath } from 'node:url';
import { Parser } from '@etothepii/satisfactory-file-parser';

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  console.warn('Ignoring NODE_TLS_REJECT_UNAUTHORIZED=0; Satisfactory API TLS is handled per request.');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const PORT = Number(process.env.PORT || process.env.DASHBOARD_CONTAINER_PORT || process.env.DASHBOARD_DEV_API_PORT || 8080);
const COOKIE_NAME = 'scc_session';
const APP_DATA_DIR = process.env.APP_DATA_DIR || path.join(projectRoot, 'data', 'dashboard');
const SETTINGS_FILE = path.join(APP_DATA_DIR, 'settings.json');
const SAVE_ROOT = process.env.SAVE_ROOT || path.join(projectRoot, 'data', 'satisfactory-server', 'saved');
const SATISFACTORY_API_PROTOCOL = process.env.SATISFACTORY_API_PROTOCOL || 'https';
const SATISFACTORY_API_HOST = process.env.SATISFACTORY_API_HOST || '127.0.0.1';
const SATISFACTORY_API_PORT = process.env.SATISFACTORY_API_PORT || '7777';
const SATISFACTORY_API_URL =
  normalizeApiUrl(process.env.SATISFACTORY_API_URL) ||
  normalizeApiUrl(`${SATISFACTORY_API_PROTOCOL}://${SATISFACTORY_API_HOST}:${SATISFACTORY_API_PORT}`);
const SATISFACTORY_CONTAINER_NAME = process.env.SATISFACTORY_CONTAINER_NAME || 'satisfactory-server';
const SATISFACTORY_SERVICE_NAME = process.env.SATISFACTORY_SERVICE_NAME || 'satisfactory-server';
const SATISFACTORY_IMAGE = process.env.SATISFACTORY_IMAGE || 'wolveix/satisfactory-server:latest';
const WEB_ADMIN_PASSWORD = process.env.WEB_ADMIN_PASSWORD || 'change-me-now';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(48).toString('hex');
const ENABLE_SAVE_MAP_PARSING = truthy(process.env.ENABLE_SAVE_MAP_PARSING);
const MAX_SAVE_PARSE_BYTES = Number(process.env.MAX_SAVE_PARSE_BYTES || 100 * 1024 * 1024);
const docker = new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
const tlsDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_SAVE_UPLOAD_BYTES || 1024 * 1024 * 1024) }
});

let cachedGameToken = null;
let updateJob = null;
let latestSaveMapCache = null;

class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function normalizeApiUrl(value) {
  if (!value) {
    return '';
  }
  const trimmed = String(value).trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

function truthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function nowIso() {
  return new Date().toISOString();
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function publicError(error) {
  return {
    message: error.message || 'Unbekannter Fehler',
    details: error.details,
    status: error.status || 500
  };
}

async function ensureDataDir() {
  await fs.mkdir(APP_DATA_DIR, { recursive: true });
}

async function readSettings() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeSettings(patch) {
  const current = await readSettings();
  const next = { ...current, ...patch, updatedAt: nowIso() };
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === '') {
      delete next[key];
    }
  }
  await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function sanitizeSettings(settings) {
  return {
    hasAdminPassword: Boolean(process.env.SATISFACTORY_ADMIN_PASSWORD || settings.satisfactoryAdminPassword),
    hasApiToken: Boolean(process.env.SATISFACTORY_API_TOKEN || settings.satisfactoryApiToken),
    frmBaseUrl: process.env.FRM_BASE_URL || settings.frmBaseUrl || '',
    enableSaveMapParsing: ENABLE_SAVE_MAP_PARSING,
    maxSaveParseBytes: MAX_SAVE_PARSE_BYTES,
    saveRoot: SAVE_ROOT,
    apiUrl: SATISFACTORY_API_URL,
    containerName: SATISFACTORY_CONTAINER_NAME,
    image: SATISFACTORY_IMAGE
  };
}

function createSession(res) {
  const token = jwt.sign({ scope: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: truthy(process.env.COOKIE_SECURE),
    maxAge: 12 * 60 * 60 * 1000
  });
}

function requireAuth(req, _res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice('Bearer '.length)
    : null;
  const token = req.cookies?.[COOKIE_NAME] || bearer;
  if (!token) {
    throw new HttpError(401, 'Nicht angemeldet');
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    throw new HttpError(401, 'Session abgelaufen');
  }
}

function decodeEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const errorCode = payload.errorCode ?? payload.ErrorCode;
  if (errorCode) {
    throw new HttpError(502, payload.errorMessage || payload.ErrorMessage || errorCode, { errorCode });
  }

  return payload.data ?? payload.Data ?? payload;
}

async function fetchSatisfactory(functionName, data = {}, options = {}) {
  const body = JSON.stringify({ function: functionName, data });
  const headers = { 'content-type': 'application/json' };
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(SATISFACTORY_API_URL, {
    method: 'POST',
    headers,
    body,
    dispatcher: tlsDispatcher,
    signal: AbortSignal.timeout(Number(process.env.SATISFACTORY_API_TIMEOUT_MS || 7000))
  });

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    throw new HttpError(response.status, `Satisfactory API ${functionName} fehlgeschlagen`, payload);
  }

  return decodeEnvelope(payload);
}

function readAuthToken(loginResponse) {
  return (
    loginResponse?.AuthenticationToken ||
    loginResponse?.authenticationToken ||
    loginResponse?.token ||
    null
  );
}

async function getGameAuthToken(force = false) {
  const settings = await readSettings();
  const configuredToken = process.env.SATISFACTORY_API_TOKEN || settings.satisfactoryApiToken;
  if (configuredToken) {
    return configuredToken;
  }

  if (cachedGameToken && !force) {
    return cachedGameToken;
  }

  const password = process.env.SATISFACTORY_ADMIN_PASSWORD || settings.satisfactoryAdminPassword;
  if (!password) {
    return null;
  }

  const login = await fetchSatisfactory('PasswordLogin', {
    Password: password,
    MinimumPrivilegeLevel: 'Administrator'
  });
  cachedGameToken = readAuthToken(login);
  if (!cachedGameToken) {
    throw new HttpError(502, 'Die Satisfactory-API hat kein Auth-Token geliefert');
  }
  return cachedGameToken;
}

async function callGame(functionName, data = {}, { auth = 'auto', retry = true } = {}) {
  let token = null;
  if (auth !== 'none') {
    token = await getGameAuthToken();
  }

  try {
    return await fetchSatisfactory(functionName, data, { token });
  } catch (error) {
    if (retry && auth !== 'none' && (error.status === 401 || error.status === 403)) {
      cachedGameToken = null;
      const newToken = await getGameAuthToken(true);
      return fetchSatisfactory(functionName, data, { token: newToken });
    }
    throw error;
  }
}

async function callGameMultipart(functionName, data, file) {
  const token = await getGameAuthToken();
  if (!token) {
    throw new HttpError(401, 'Satisfactory-Admin-Auth fehlt');
  }

  const formData = new FormData();
  formData.set(
    'data',
    new Blob([JSON.stringify({ function: functionName, data })], { type: 'application/json' })
  );
  formData.set(
    'saveGameFile',
    new Blob([file.buffer], { type: 'application/octet-stream' }),
    file.originalname
  );

  const response = await fetch(SATISFACTORY_API_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: formData,
    dispatcher: tlsDispatcher,
    signal: AbortSignal.timeout(Number(process.env.SATISFACTORY_UPLOAD_TIMEOUT_MS || 120000))
  });

  if (response.status === 204 || response.status === 201 || response.status === 202) {
    return null;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new HttpError(response.status, `Satisfactory API ${functionName} fehlgeschlagen`, payload);
  }
  return decodeEnvelope(payload);
}

async function resolveSatisfactoryContainer() {
  const directCandidates = [SATISFACTORY_CONTAINER_NAME, SATISFACTORY_SERVICE_NAME].filter(Boolean);
  for (const name of directCandidates) {
    try {
      const container = docker.getContainer(name);
      const inspect = await container.inspect();
      return { container, inspect };
    } catch (error) {
      if (error.statusCode && error.statusCode !== 404) {
        throw error;
      }
    }
  }

  const containers = await docker.listContainers({ all: true });
  const match = containers.find((candidate) => {
    const names = candidate.Names || [];
    const serviceLabel = candidate.Labels?.['com.docker.compose.service'];
    return (
      serviceLabel === SATISFACTORY_SERVICE_NAME ||
      names.some((name) => {
        const clean = name.replace(/^\//, '');
        return (
          clean === SATISFACTORY_CONTAINER_NAME ||
          clean === SATISFACTORY_SERVICE_NAME ||
          clean.startsWith(`${SATISFACTORY_SERVICE_NAME}-`) ||
          clean.startsWith(`${SATISFACTORY_CONTAINER_NAME}-`)
        );
      })
    );
  });

  if (!match) {
    throw new HttpError(
      404,
      `Satisfactory-Container nicht gefunden: ${SATISFACTORY_CONTAINER_NAME}/${SATISFACTORY_SERVICE_NAME}`
    );
  }

  const container = docker.getContainer(match.Id);
  return { container, inspect: await container.inspect() };
}

function calculateCpuPercent(stats) {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage || 0) -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const cpus =
    stats.cpu_stats?.online_cpus ||
    stats.cpu_stats?.cpu_usage?.percpu_usage?.length ||
    1;

  if (systemDelta <= 0 || cpuDelta <= 0) {
    return 0;
  }
  return (cpuDelta / systemDelta) * cpus * 100;
}

function normalizeStats(stats) {
  if (!stats) {
    return null;
  }

  const rawMemory = stats.memory_stats?.usage || 0;
  const cache = stats.memory_stats?.stats?.cache || 0;
  const memoryUsage = Math.max(rawMemory - cache, 0);
  const memoryLimit = stats.memory_stats?.limit || 0;
  const networks = Object.values(stats.networks || {}).reduce(
    (sum, item) => ({
      rxBytes: sum.rxBytes + (item.rx_bytes || 0),
      txBytes: sum.txBytes + (item.tx_bytes || 0)
    }),
    { rxBytes: 0, txBytes: 0 }
  );

  return {
    cpuPercent: calculateCpuPercent(stats),
    memoryUsage,
    memoryLimit,
    memoryPercent: memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0,
    pids: stats.pids_stats?.current || 0,
    networks
  };
}

async function getDockerStatus() {
  const { container, inspect } = await resolveSatisfactoryContainer();
  let stats = null;
  if (inspect.State?.Running) {
    stats = normalizeStats(await container.stats({ stream: false }));
  }

  return {
    id: inspect.Id,
    name: inspect.Name?.replace(/^\//, ''),
    image: inspect.Config?.Image,
    state: inspect.State,
    created: inspect.Created,
    startedAt: inspect.State?.StartedAt,
    ports: inspect.NetworkSettings?.Ports,
    stats
  };
}

function parseImageRef(image) {
  const withoutRegistry = image.replace(/^docker\.io\//, '');
  const [repoPart, tagPart] = withoutRegistry.includes(':')
    ? withoutRegistry.split(/:(?=[^/]+$)/)
    : [withoutRegistry, 'latest'];
  const repo = repoPart.includes('/') ? repoPart : `library/${repoPart}`;
  return { repo, tag: tagPart || 'latest' };
}

async function getRemoteDigest(image) {
  const { repo, tag } = parseImageRef(image);
  const tokenUrl = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
  const tokenResponse = await fetch(tokenUrl, { signal: AbortSignal.timeout(10000) });
  if (!tokenResponse.ok) {
    throw new HttpError(tokenResponse.status, 'Docker-Hub-Token konnte nicht geladen werden');
  }
  const { token } = await tokenResponse.json();
  const manifestResponse = await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      accept: [
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
      ].join(', ')
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!manifestResponse.ok) {
    throw new HttpError(manifestResponse.status, 'Remote Docker-Manifest konnte nicht gelesen werden');
  }

  return manifestResponse.headers.get('docker-content-digest');
}

async function getLocalDigest(image) {
  try {
    const inspect = await docker.getImage(image).inspect();
    const { repo } = parseImageRef(image);
    const digest = inspect.RepoDigests?.find((entry) => entry.startsWith(`${repo}@`) || entry.includes(`/${repo}@`));
    return digest?.split('@')[1] || null;
  } catch {
    return null;
  }
}

async function checkForUpdate() {
  const [remoteDigest, localDigest] = await Promise.all([
    getRemoteDigest(SATISFACTORY_IMAGE),
    getLocalDigest(SATISFACTORY_IMAGE)
  ]);
  return {
    image: SATISFACTORY_IMAGE,
    remoteDigest,
    localDigest,
    updateAvailable: Boolean(remoteDigest && localDigest && remoteDigest !== localDigest),
    localImageMissing: Boolean(remoteDigest && !localDigest),
    checkedAt: nowIso()
  };
}

function summarizeJob(job) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
    logs: job.logs.slice(-100)
  };
}

function pushJobLog(job, message) {
  job.logs.push({ at: nowIso(), message });
}

async function pullImage(job) {
  pushJobLog(job, `Pull ${SATISFACTORY_IMAGE}`);
  await new Promise((resolve, reject) => {
    docker.pull(SATISFACTORY_IMAGE, (pullError, stream) => {
      if (pullError) {
        reject(pullError);
        return;
      }
      docker.modem.followProgress(
        stream,
        (progressError) => {
          if (progressError) reject(progressError);
          else resolve();
        },
        (event) => {
          if (event.status) {
            const suffix = event.progress ? ` ${event.progress}` : '';
            pushJobLog(job, `${event.status}${suffix}`);
          }
        }
      );
    });
  });
}

async function runUpdateJob() {
  const job = updateJob;
  try {
    job.status = 'running';
    pushJobLog(job, 'Update gestartet');

    try {
      const saveName = `pre-update-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await callGame('SaveGame', { SaveName: saveName }, { auth: 'auto' });
      pushJobLog(job, `Save angelegt: ${saveName}`);
    } catch (error) {
      pushJobLog(job, `Pre-Update-Save uebersprungen: ${error.message}`);
    }

    await pullImage(job);

    const { container, inspect } = await resolveSatisfactoryContainer();
    if (inspect.State?.Running) {
      pushJobLog(job, 'Container wird neu gestartet');
      await container.restart({ t: 20 });
    } else {
      pushJobLog(job, 'Container wird gestartet');
      await container.start();
    }

    job.status = 'completed';
    job.finishedAt = nowIso();
    pushJobLog(job, 'Update abgeschlossen');
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = nowIso();
    job.error = error.message;
    pushJobLog(job, `Fehler: ${error.message}`);
  }
}

async function walkSaves(dir, depth = 0) {
  if (depth > 8) {
    return [];
  }
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkSaves(fullPath, depth + 1)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.sav')) {
      const stat = await fs.stat(fullPath);
      files.push({ path: fullPath, name: entry.name, modifiedAt: stat.mtime.toISOString(), size: stat.size });
    }
  }
  return files;
}

function asArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function readProperty(properties, names) {
  for (const name of names) {
    const property = properties?.[name];
    if (property === undefined || property === null) {
      continue;
    }
    if (typeof property !== 'object') {
      return property;
    }
    if ('value' in property) {
      return property.value;
    }
    if ('values' in property) {
      return property.values;
    }
  }
  return null;
}

function normalizePosition(translation) {
  if (!translation) {
    return null;
  }
  const x = Number(translation.x);
  const y = Number(translation.y);
  const z = Number(translation.z || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  return { x, y, z };
}

function extractSaveMap(save, metadata = {}) {
  const levels = Object.values(save.levels || {});
  const objects = levels.flatMap((level) => level.objects || []);
  const players = [];
  const markers = [];

  for (const object of objects) {
    const typePath = object.typePath || '';
    const position = normalizePosition(object.transform?.translation);
    if (!position) {
      continue;
    }

    if (typePath.includes('/Character/Player/Char_Player')) {
      players.push({
        id: object.instanceName,
        name:
          readProperty(object.properties, ['mCachedPlayerName', 'mPlayerName', 'mPlayerNickname']) ||
          object.instanceName?.split('.')?.pop() ||
          'Pioneer',
        position,
        online: null,
        source: 'save'
      });
      continue;
    }

    if (typePath.includes('Build_TradingPost')) {
      markers.push({ id: object.instanceName, label: 'HUB', type: 'hub', position });
    } else if (typePath.includes('Build_SpaceElevator')) {
      markers.push({ id: object.instanceName, label: 'Space Elevator', type: 'space-elevator', position });
    } else if (typePath.includes('Build_RadarTower')) {
      markers.push({ id: object.instanceName, label: 'Radar', type: 'radar', position });
    }
  }

  return {
    source: 'save',
    save: metadata,
    parsedAt: nowIso(),
    bounds: { minX: -324600, maxX: 425300, minY: -375000, maxY: 375000 },
    players,
    markers,
    objectCount: objects.length
  };
}

function skippedSaveMap(source, metadata, warning) {
  return {
    source,
    save: metadata,
    parsedAt: null,
    warning,
    bounds: { minX: -324600, maxX: 425300, minY: -375000, maxY: 375000 },
    players: [],
    markers: [],
    objectCount: 0
  };
}

function saveParseGate(size) {
  if (!ENABLE_SAVE_MAP_PARSING) {
    return {
      ok: false,
      warning: 'Savegame-Parsing ist deaktiviert. Setze ENABLE_SAVE_MAP_PARSING=true, oder nutze FRM_BASE_URL fuer Live-Positionen.'
    };
  }

  if (Number.isFinite(MAX_SAVE_PARSE_BYTES) && MAX_SAVE_PARSE_BYTES > 0 && size > MAX_SAVE_PARSE_BYTES) {
    return {
      ok: false,
      warning: `Savegame ist zu gross fuer automatisches Parsing (${formatBytes(size)} > ${formatBytes(MAX_SAVE_PARSE_BYTES)}).`
    };
  }

  return { ok: true };
}

async function parseSaveBuffer(buffer, name = 'save.sav', metadata = {}) {
  const save = Parser.ParseSave(name, asArrayBuffer(buffer), { throwErrors: false });
  return extractSaveMap(save, metadata);
}

async function parseSaveBufferIfAllowed(buffer, name, metadata, source = 'save') {
  const gate = saveParseGate(metadata?.size || buffer.length || 0);
  if (!gate.ok) {
    return skippedSaveMap(source, metadata, gate.warning);
  }
  return parseSaveBuffer(buffer, name, metadata);
}

async function getLatestSaveMap() {
  const saves = await walkSaves(SAVE_ROOT);
  const latest = saves.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))[0];
  if (!latest) {
    return {
      source: 'none',
      bounds: { minX: -324600, maxX: 425300, minY: -375000, maxY: 375000 },
      players: [],
      markers: [],
      save: null
    };
  }

  const gate = saveParseGate(latest.size);
  if (!gate.ok) {
    return skippedSaveMap('save-disabled', latest, gate.warning);
  }

  const cacheKey = `${latest.path}:${latest.modifiedAt}:${latest.size}`;
  if (latestSaveMapCache?.key === cacheKey) {
    return latestSaveMapCache.data;
  }

  const buffer = await fs.readFile(latest.path);
  const data = await parseSaveBuffer(buffer, latest.name, latest);
  latestSaveMapCache = { key: cacheKey, data };
  return data;
}

function normalizeFrmPlayers(players) {
  return (Array.isArray(players) ? players : []).map((player) => ({
    id: player.ID || player.id || player.Name,
    name: player.Name || player.name || 'Pioneer',
    position: normalizePosition(player.location || player.Location),
    rotation: player.location?.rotation,
    online: Boolean(player.Online ?? player.online),
    dead: Boolean(player.Dead ?? player.dead),
    hp: Number(player.PlayerHP ?? player.hp ?? 0),
    speed: Number(player.Speed ?? player.speed ?? 0),
    inventory: player.Inventory || [],
    source: 'frm'
  })).filter((player) => player.position);
}

async function getFrmPlayers() {
  const settings = await readSettings();
  const baseUrl = (process.env.FRM_BASE_URL || settings.frmBaseUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    return null;
  }

  const response = await fetch(`${baseUrl}/getPlayer`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new HttpError(response.status, 'FRM getPlayer fehlgeschlagen');
  }
  const payload = await response.json();
  return {
    source: 'frm',
    fetchedAt: nowIso(),
    bounds: { minX: -324600, maxX: 425300, minY: -375000, maxY: 375000 },
    players: normalizeFrmPlayers(payload),
    markers: []
  };
}

async function getMapData() {
  try {
    const frm = await getFrmPlayers();
    if (frm) {
      return frm;
    }
  } catch (error) {
    const save = await getLatestSaveMap();
    return { ...save, warning: error.message };
  }
  return getLatestSaveMap();
}

function normalizeServerGameState(payload) {
  const state = payload?.ServerGameState || payload?.serverGameState || payload || {};
  return {
    activeSessionName: state.ActiveSessionName ?? state.activeSessionName ?? '',
    numConnectedPlayers: state.NumConnectedPlayers ?? state.numConnectedPlayers ?? 0,
    playerLimit: state.PlayerLimit ?? state.playerLimit ?? 0,
    techTier: state.TechTier ?? state.techTier ?? null,
    activeSchematic: state.ActiveSchematic ?? state.activeSchematic ?? '',
    gamePhase: state.GamePhase ?? state.gamePhase ?? '',
    isGameRunning: state.IsGameRunning ?? state.isGameRunning ?? false,
    totalGameDuration: state.TotalGameDuration ?? state.totalGameDuration ?? 0,
    isGamePaused: state.IsGamePaused ?? state.isGamePaused ?? false,
    averageTickRate: state.AverageTickRate ?? state.averageTickRate ?? 0,
    autoLoadSessionName: state.AutoLoadSessionName ?? state.autoLoadSessionName ?? '',
    raw: state
  };
}

async function settle(name, promise) {
  try {
    return { name, ok: true, data: await promise };
  } catch (error) {
    return { name, ok: false, error: publicError(error) };
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true, now: nowIso() });
});

app.post('/api/auth/login', loginLimiter, asyncHandler(async (req, res) => {
  if (!req.body?.password || req.body.password !== WEB_ADMIN_PASSWORD) {
    throw new HttpError(401, 'Falsches Passwort');
  }
  createSession(res);
  res.json({ ok: true });
}));

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (_req, res) => {
  res.json({ authenticated: true });
});

app.use('/api', requireAuth);

app.get('/api/settings', asyncHandler(async (_req, res) => {
  res.json(sanitizeSettings(await readSettings()));
}));

app.post('/api/settings', asyncHandler(async (req, res) => {
  const patch = {};
  if ('frmBaseUrl' in req.body) patch.frmBaseUrl = String(req.body.frmBaseUrl || '').trim();
  if ('satisfactoryAdminPassword' in req.body) {
    patch.satisfactoryAdminPassword = String(req.body.satisfactoryAdminPassword || '');
    cachedGameToken = null;
  }
  if ('satisfactoryApiToken' in req.body) {
    patch.satisfactoryApiToken = String(req.body.satisfactoryApiToken || '');
    cachedGameToken = null;
  }
  const settings = await writeSettings(patch);
  res.json(sanitizeSettings(settings));
}));

app.post('/api/satisfactory/claim', asyncHandler(async (req, res) => {
  const serverName = String(req.body?.serverName || '').trim();
  const adminPassword = String(req.body?.adminPassword || '');
  const clientPassword = String(req.body?.clientPassword || '');
  if (!serverName || !adminPassword) {
    throw new HttpError(400, 'Servername und Admin-Passwort sind erforderlich');
  }

  const initial = await fetchSatisfactory('PasswordlessLogin', { MinimumPrivilegeLevel: 'InitialAdmin' });
  const initialToken = readAuthToken(initial);
  if (!initialToken) {
    throw new HttpError(403, 'InitialAdmin-Token konnte nicht geholt werden. Ist der Server schon geclaimed?');
  }
  const claimed = await fetchSatisfactory('ClaimServer', {
    ServerName: serverName,
    AdminPassword: adminPassword
  }, { token: initialToken });

  await writeSettings({ satisfactoryAdminPassword: adminPassword });
  cachedGameToken = readAuthToken(claimed) || null;

  if (clientPassword) {
    await callGame('SetClientPassword', { Password: clientPassword });
  }

  res.json({ ok: true });
}));

app.get('/api/overview', asyncHandler(async (_req, res) => {
  const [dockerStatus, serverState, health, map, settings] = await Promise.all([
    settle('docker', getDockerStatus()),
    settle('serverState', callGame('QueryServerState', {}, { auth: 'auto' }).then(normalizeServerGameState)),
    settle('health', callGame('HealthCheck', { ClientCustomData: '' }, { auth: 'none' })),
    settle('map', getMapData()),
    settle('settings', readSettings().then(sanitizeSettings))
  ]);

  res.json({
    generatedAt: nowIso(),
    docker: dockerStatus,
    serverState,
    health,
    map,
    settings,
    updateJob: summarizeJob(updateJob)
  });
}));

app.post('/api/docker/:action', asyncHandler(async (req, res) => {
  const action = req.params.action;
  const { container } = await resolveSatisfactoryContainer();
  if (action === 'start') {
    await container.start();
  } else if (action === 'stop') {
    await container.stop({ t: 20 });
  } else if (action === 'restart') {
    await container.restart({ t: 20 });
  } else {
    throw new HttpError(404, 'Unbekannte Docker-Aktion');
  }
  res.json({ ok: true, action });
}));

app.get('/api/update/check', asyncHandler(async (_req, res) => {
  res.json(await checkForUpdate());
}));

app.post('/api/update/apply', asyncHandler(async (_req, res) => {
  if (updateJob && updateJob.status === 'running') {
    res.json(summarizeJob(updateJob));
    return;
  }
  updateJob = {
    id: crypto.randomUUID(),
    status: 'queued',
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
    logs: []
  };
  runUpdateJob();
  res.status(202).json(summarizeJob(updateJob));
}));

app.get('/api/update/job', (_req, res) => {
  res.json(summarizeJob(updateJob));
});

app.get('/api/saves', asyncHandler(async (_req, res) => {
  res.json(await callGame('EnumerateSessions', {}, { auth: 'auto' }));
}));

app.post('/api/saves/save', asyncHandler(async (req, res) => {
  const saveName = String(req.body?.saveName || `manual-${Date.now()}`).trim();
  res.json({ data: await callGame('SaveGame', { SaveName: saveName }, { auth: 'auto' }) });
}));

app.post('/api/saves/load', asyncHandler(async (req, res) => {
  const saveName = String(req.body?.saveName || '').trim();
  if (!saveName) {
    throw new HttpError(400, 'SaveName fehlt');
  }
  res.json({
    data: await callGame('LoadGame', {
      SaveName: saveName,
      EnableAdvancedGameSettings: Boolean(req.body?.enableAdvancedGameSettings)
    }, { auth: 'auto' })
  });
}));

app.post('/api/saves/upload', upload.single('saveGameFile'), asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new HttpError(400, 'Savegame-Datei fehlt');
  }
  const saveName = String(req.body?.saveName || req.file.originalname.replace(/\.sav$/i, '')).trim();
  const loadSaveGame = truthy(req.body?.loadSaveGame);
  const enableAdvancedGameSettings = truthy(req.body?.enableAdvancedGameSettings);
  const [uploadResult, parsed] = await Promise.all([
    callGameMultipart('UploadSaveGame', {
      SaveName: saveName,
      LoadSaveGame: loadSaveGame,
      EnableAdvancedGameSettings: enableAdvancedGameSettings
    }, req.file),
    parseSaveBufferIfAllowed(req.file.buffer, req.file.originalname, {
      name: req.file.originalname,
      size: req.file.size,
      uploadedAt: nowIso()
    }, 'upload').catch((error) => ({ source: 'upload', error: error.message, players: [], markers: [] }))
  ]);
  res.json({ ok: true, uploadResult, map: parsed });
}));

app.get('/api/saves/download/:saveName', asyncHandler(async (req, res) => {
  const token = await getGameAuthToken();
  if (!token) {
    throw new HttpError(401, 'Satisfactory-Admin-Auth fehlt');
  }

  const response = await fetch(SATISFACTORY_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      function: 'DownloadSaveGame',
      data: { SaveName: req.params.saveName }
    }),
    dispatcher: tlsDispatcher,
    signal: AbortSignal.timeout(120000)
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new HttpError(response.status, 'DownloadSaveGame fehlgeschlagen', payload);
  }

  const filename = `${req.params.saveName.replace(/[^a-zA-Z0-9_.-]/g, '_')}.sav`;
  res.setHeader('content-type', response.headers.get('content-type') || 'application/octet-stream');
  res.setHeader('content-disposition', response.headers.get('content-disposition') || `attachment; filename="${filename}"`);
  const buffer = Buffer.from(await response.arrayBuffer());
  res.send(buffer);
}));

app.get('/api/map/latest', asyncHandler(async (_req, res) => {
  res.json(await getMapData());
}));

app.post('/api/map/parse', upload.single('saveGameFile'), asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new HttpError(400, 'Savegame-Datei fehlt');
  }
  res.json(await parseSaveBufferIfAllowed(req.file.buffer, req.file.originalname, {
    name: req.file.originalname,
    size: req.file.size,
    uploadedAt: nowIso()
  }, 'upload'));
}));

const distDir = path.join(projectRoot, 'dist');
if (fsSync.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ error: publicError(error) });
});

app.listen(PORT, () => {
  console.log(`Satisfactory Command Center listening on ${PORT}`);
});
