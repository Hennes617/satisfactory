import {
  Activity,
  ArrowDownToLine,
  Cpu,
  Database,
  Eye,
  Gauge,
  HardDriveUpload,
  KeyRound,
  Loader2,
  LogOut,
  MapPinned,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Shield,
  Square,
  Upload,
  Users
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const POLL_MS = 5000;
const MAP_BOUNDS = { minX: -324600, maxX: 425300, minY: -375000, maxY: 375000 };

async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: options.body instanceof FormData ? undefined : { 'content-type': 'application/json' },
    ...options
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return '-';
  const total = Math.max(0, Math.floor(Number(seconds)));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPercent(value) {
  return `${Math.max(0, Number(value || 0)).toFixed(1)}%`;
}

function formatCoord(position) {
  if (!position) return '-';
  return `${Math.round(position.x / 100)}, ${Math.round(position.y / 100)}, ${Math.round((position.z || 0) / 100)} m`;
}

function resultData(result) {
  return result?.ok ? result.data : null;
}

function resultError(result) {
  return result?.ok === false ? result.error?.message || 'Nicht verfuegbar' : null;
}

function classNames(...items) {
  return items.filter(Boolean).join(' ');
}

function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ password })
      });
      onLogin();
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-mark">
          <Shield size={28} />
        </div>
        <h1>Satisfactory Command Center</h1>
        <p>Server, Saves, Updates und Map hinter einem lokalen Admin-Login.</p>
        <label>
          Admin-Passwort
          <input
            autoFocus
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="WEB_ADMIN_PASSWORD"
          />
        </label>
        {error ? <div className="error-line">{error}</div> : null}
        <button className="primary-button" disabled={busy || !password}>
          {busy ? <Loader2 className="spin" size={18} /> : <KeyRound size={18} />}
          Anmelden
        </button>
      </form>
    </main>
  );
}

function StatCard({ icon, label, value, detail }) {
  return (
    <section className="stat-card">
      <div className="card-icon">{icon}</div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </section>
  );
}

function ProgressBar({ value }) {
  const clamped = Math.min(100, Math.max(0, Number(value || 0)));
  return (
    <div className="progress-track">
      <div className="progress-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function ServerControls({ dockerStatus, onRefresh }) {
  const [busy, setBusy] = useState('');
  const running = dockerStatus?.state?.Running;

  async function action(name) {
    setBusy(name);
    try {
      await request(`/api/docker/${name}`, { method: 'POST' });
      await onRefresh();
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="button-row">
      <button onClick={() => action('start')} disabled={busy || running}>
        {busy === 'start' ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
        Start
      </button>
      <button onClick={() => action('stop')} disabled={busy || !running}>
        {busy === 'stop' ? <Loader2 className="spin" size={16} /> : <Square size={16} />}
        Stop
      </button>
      <button onClick={() => action('restart')} disabled={busy || !dockerStatus}>
        {busy === 'restart' ? <Loader2 className="spin" size={16} /> : <RotateCcw size={16} />}
        Restart
      </button>
    </div>
  );
}

function Header({ overview, onLogout, onRefresh }) {
  const dockerStatus = resultData(overview?.docker);
  const running = dockerStatus?.state?.Running;

  return (
    <header className="topbar">
      <div>
        <div className="eyebrow">Dedicated Server Dashboard</div>
        <h1>Satisfactory Command Center</h1>
      </div>
      <div className="topbar-actions">
        <span className={classNames('status-pill', running ? 'online' : 'offline')}>
          <Power size={14} />
          {running ? 'Online' : 'Offline'}
        </span>
        <button className="icon-button" onClick={onRefresh} aria-label="Aktualisieren" title="Aktualisieren">
          <RefreshCw size={18} />
        </button>
        <button className="icon-button" onClick={onLogout} aria-label="Abmelden" title="Abmelden">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}

function OverviewCards({ overview }) {
  const dockerStatus = resultData(overview?.docker);
  const serverState = resultData(overview?.serverState);
  const health = resultData(overview?.health);
  const stats = dockerStatus?.stats;

  return (
    <div className="stat-grid">
      <StatCard
        icon={<Users size={20} />}
        label="Spieler"
        value={`${serverState?.numConnectedPlayers ?? 0}/${serverState?.playerLimit || '-'}`}
        detail={serverState?.activeSessionName || 'Keine Session erkannt'}
      />
      <StatCard
        icon={<Activity size={20} />}
        label="Weltzeit"
        value={formatDuration(serverState?.totalGameDuration)}
        detail={serverState?.isGamePaused ? 'Pausiert' : 'Laeuft'}
      />
      <StatCard
        icon={<Cpu size={20} />}
        label="CPU"
        value={stats ? formatPercent(stats.cpuPercent) : '-'}
        detail={`${stats?.pids ?? 0} Prozesse`}
      />
      <StatCard
        icon={<Gauge size={20} />}
        label="Tickrate"
        value={serverState?.averageTickRate ? `${Number(serverState.averageTickRate).toFixed(1)} Hz` : '-'}
        detail={health ? 'API erreichbar' : resultError(overview?.health) || 'Health unbekannt'}
      />
    </div>
  );
}

function ResourcePanel({ overview, onRefresh }) {
  const dockerStatus = resultData(overview?.docker);
  const dockerError = resultError(overview?.docker);
  const stats = dockerStatus?.stats;

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Server</h2>
          <p>{dockerStatus?.image || dockerError || 'Container nicht gefunden'}</p>
        </div>
        <ServerControls dockerStatus={dockerStatus} onRefresh={onRefresh} />
      </div>
      <div className="metric-list">
        <div>
          <div className="metric-label">RAM</div>
          <strong>{stats ? `${formatBytes(stats.memoryUsage)} / ${formatBytes(stats.memoryLimit)}` : '-'}</strong>
          <ProgressBar value={stats?.memoryPercent} />
        </div>
        <div>
          <div className="metric-label">CPU</div>
          <strong>{stats ? formatPercent(stats.cpuPercent) : '-'}</strong>
          <ProgressBar value={stats?.cpuPercent} />
        </div>
        <div className="network-strip">
          <span>RX {formatBytes(stats?.networks?.rxBytes || 0)}</span>
          <span>TX {formatBytes(stats?.networks?.txBytes || 0)}</span>
          <span>Start {dockerStatus?.startedAt ? new Date(dockerStatus.startedAt).toLocaleString() : '-'}</span>
        </div>
      </div>
    </section>
  );
}

function toMapPoint(position, bounds = MAP_BOUNDS) {
  const left = ((position.x - bounds.minX) / (bounds.maxX - bounds.minX)) * 100;
  const top = (1 - (position.y - bounds.minY) / (bounds.maxY - bounds.minY)) * 100;
  return {
    left: `${Math.min(98, Math.max(2, left))}%`,
    top: `${Math.min(98, Math.max(2, top))}%`
  };
}

function MapPanel({ overview }) {
  const map = resultData(overview?.map) || {};
  const mapError = resultError(overview?.map);
  const players = map.players || [];
  const markers = map.markers || [];
  const bounds = map.bounds || MAP_BOUNDS;
  const sourceLabel = map.source === 'frm' ? 'FRM live' : map.source === 'save' ? 'Neuestes Save' : 'Keine Quelle';

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <div>
          <h2>Karte</h2>
          <p>{map.warning || mapError || sourceLabel}</p>
        </div>
        <span className="soft-pill">
          <MapPinned size={14} />
          {players.length} Marker
        </span>
      </div>
      <div className="map-shell">
        <div className="map-surface">
          <img className="map-image" src="/assets/satisfactory-map.jpg" alt="" draggable="false" />
          <div className="map-grid" />
          {markers.map((marker) => (
            <div
              key={marker.id}
              className={classNames('map-marker', marker.type)}
              style={toMapPoint(marker.position, bounds)}
              title={`${marker.label} ${formatCoord(marker.position)}`}
            >
              <Database size={13} />
            </div>
          ))}
          {players.map((player) => (
            <div
              key={player.id || player.name}
              className={classNames('player-marker', player.online === false && 'muted-marker')}
              style={toMapPoint(player.position, bounds)}
              title={`${player.name}: ${formatCoord(player.position)}`}
            >
              <span>{player.name?.slice(0, 1)?.toUpperCase() || 'P'}</span>
            </div>
          ))}
        </div>
        <aside className="player-list">
          {players.length === 0 ? (
            <div className="empty-state">
              <Eye size={18} />
              Keine Spielerpositionen. FRM aktivieren oder Savegame einlesen.
            </div>
          ) : (
            players.map((player) => (
              <div className="player-row" key={player.id || player.name}>
                <span className="avatar">{player.name?.slice(0, 1)?.toUpperCase() || 'P'}</span>
                <div>
                  <strong>{player.name}</strong>
                  <small>{formatCoord(player.position)}</small>
                </div>
                <span className={classNames('mini-status', player.source === 'frm' && 'live')}>
                  {player.source === 'frm' ? 'live' : 'save'}
                </span>
              </div>
            ))
          )}
        </aside>
      </div>
    </section>
  );
}

function UpdatePanel({ overview }) {
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(overview?.updateJob || null);

  useEffect(() => {
    setJob(overview?.updateJob || null);
  }, [overview?.updateJob]);

  useEffect(() => {
    if (!job || job.status !== 'running') return undefined;
    const timer = setInterval(async () => {
      try {
        setJob(await request('/api/update/job'));
      } catch {
        // The overview poll will surface API failures.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [job]);

  async function checkUpdate() {
    setBusy(true);
    setError('');
    try {
      const result = await request('/api/update/check');
      setCheck(result);
      setConfirm(true);
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyUpdate() {
    setBusy(true);
    setError('');
    try {
      setJob(await request('/api/update/apply', { method: 'POST' }));
      setConfirm(false);
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Updates</h2>
          <p>{check ? `Geprueft: ${new Date(check.checkedAt).toLocaleString()}` : 'Docker-Image und Server-Neustart'}</p>
        </div>
        <button onClick={checkUpdate} disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          Check
        </button>
      </div>
      <div className="update-body">
        <div className="update-state">
          <strong>{check?.updateAvailable ? 'Update verfuegbar' : check ? 'Kein Image-Update erkannt' : 'Bereit'}</strong>
          <small>{check?.image || 'wolveix/satisfactory-server:latest'}</small>
        </div>
        {job ? (
          <div className="job-box">
            <div className="job-title">
              <span className={classNames('job-dot', job.status)} />
              {job.status}
            </div>
            <div className="job-log">
              {(job.logs || []).slice(-8).map((line) => (
                <div key={`${line.at}-${line.message}`}>{line.message}</div>
              ))}
            </div>
          </div>
        ) : null}
        {error ? <div className="error-line">{error}</div> : null}
      </div>
      {confirm ? (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Update ausfuehren?</h3>
            <p>
              Das Dashboard zieht das aktuelle Server-Image und startet den Container neu. Vorher wird,
              wenn die Server-API authentifiziert ist, ein Save angelegt.
            </p>
            <div className="digest-pair">
              <span>Lokal {check?.localDigest?.slice(0, 18) || 'unbekannt'}</span>
              <span>Remote {check?.remoteDigest?.slice(0, 18) || 'unbekannt'}</span>
            </div>
            <div className="button-row">
              <button onClick={() => setConfirm(false)}>Abbrechen</button>
              <button className="danger-button" onClick={applyUpdate} disabled={busy}>
                {busy ? <Loader2 className="spin" size={16} /> : <HardDriveUpload size={16} />}
                Update starten
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SavesPanel() {
  const [saves, setSaves] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [saveName, setSaveName] = useState(`manual-${new Date().toISOString().slice(0, 10)}`);
  const fileRef = useRef(null);

  const sessions = saves?.sessions || saves?.Sessions || [];

  async function loadSaves() {
    setBusy('list');
    setError('');
    try {
      setSaves(await request('/api/saves'));
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy('');
    }
  }

  async function saveNow() {
    setBusy('save');
    setError('');
    try {
      await request('/api/saves/save', {
        method: 'POST',
        body: JSON.stringify({ saveName })
      });
      await loadSaves();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy('');
    }
  }

  async function uploadSave(event) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    setBusy('upload');
    setError('');
    try {
      const formData = new FormData(event.currentTarget);
      await request('/api/saves/upload', {
        method: 'POST',
        body: formData
      });
      await loadSaves();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Saves</h2>
          <p>Manuelle Saves, Uploads und Downloads ueber die Server-API</p>
        </div>
        <button onClick={loadSaves} disabled={busy === 'list'}>
          {busy === 'list' ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          Liste
        </button>
      </div>
      <div className="save-controls">
        <label>
          Save-Name
          <input value={saveName} onChange={(event) => setSaveName(event.target.value)} />
        </label>
        <button onClick={saveNow} disabled={busy === 'save' || !saveName}>
          {busy === 'save' ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          Save now
        </button>
      </div>
      <form className="upload-form" onSubmit={uploadSave}>
        <input name="saveName" placeholder="Upload-Name optional" />
        <label className="file-input">
          <Upload size={16} />
          <input ref={fileRef} name="saveGameFile" type="file" accept=".sav" />
        </label>
        <label className="checkbox-row">
          <input name="loadSaveGame" type="checkbox" />
          Danach laden
        </label>
        <button disabled={busy === 'upload'}>
          {busy === 'upload' ? <Loader2 className="spin" size={16} /> : <HardDriveUpload size={16} />}
          Upload
        </button>
      </form>
      {error ? <div className="error-line">{error}</div> : null}
      <div className="session-list">
        {sessions.length === 0 ? (
          <div className="empty-state">Noch keine Save-Liste geladen.</div>
        ) : (
          sessions.map((session) => {
            const name = session.SaveName || session.saveName || session.SessionName || session.sessionName;
            return (
              <div className="session-row" key={name}>
                <div>
                  <strong>{name}</strong>
                  <small>{session.CreatedDate || session.createdDate || session.LastSaveDate || ''}</small>
                </div>
                <a href={`/api/saves/download/${encodeURIComponent(name)}`}>
                  <ArrowDownToLine size={16} />
                  Download
                </a>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function SettingsPanel({ overview, onRefresh }) {
  const settings = resultData(overview?.settings) || {};
  const [frmBaseUrl, setFrmBaseUrl] = useState(settings.frmBaseUrl || '');
  const [adminPassword, setAdminPassword] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    setFrmBaseUrl(settings.frmBaseUrl || '');
  }, [settings.frmBaseUrl]);

  async function saveSettings(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await request('/api/settings', {
        method: 'POST',
        body: JSON.stringify({
          frmBaseUrl,
          satisfactoryAdminPassword: adminPassword || undefined,
          satisfactoryApiToken: apiToken || undefined
        })
      });
      setAdminPassword('');
      setApiToken('');
      setMessage('Gespeichert');
      await onRefresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Settings</h2>
          <p>API-Auth und optionale Live-Positionsquelle</p>
        </div>
        <Settings size={20} />
      </div>
      <form className="settings-grid" onSubmit={saveSettings}>
        <label>
          FRM Base URL
          <input value={frmBaseUrl} onChange={(event) => setFrmBaseUrl(event.target.value)} placeholder="http://satisfactory-server:8080" />
        </label>
        <label>
          Admin-Passwort
          <input
            type="password"
            value={adminPassword}
            onChange={(event) => setAdminPassword(event.target.value)}
            placeholder={settings.hasAdminPassword ? 'gesetzt' : 'optional'}
          />
        </label>
        <label>
          API Token
          <input
            type="password"
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder={settings.hasApiToken ? 'gesetzt' : 'server.GenerateAPIToken'}
          />
        </label>
        <button disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          Speichern
        </button>
      </form>
      {message ? <div className="hint-line">{message}</div> : null}
    </section>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState(null);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const payload = await request('/api/overview');
      setOverview(payload);
      setError('');
    } catch (refreshError) {
      if (refreshError.status === 401) {
        setAuthenticated(false);
      } else {
        setError(refreshError.message);
      }
    }
  }, []);

  useEffect(() => {
    request('/api/auth/me')
      .then(() => {
        setAuthenticated(true);
      })
      .catch(() => {
        setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    if (!authenticated) return undefined;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [authenticated, refresh]);

  async function logout() {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthenticated(false);
    setOverview(null);
  }

  const serverState = useMemo(() => resultData(overview?.serverState), [overview]);

  if (authenticated === null) {
    return (
      <div className="loading-screen">
        <Loader2 className="spin" size={28} />
      </div>
    );
  }

  if (!authenticated) {
    return <Login onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app-shell">
      <Header overview={overview} onLogout={logout} onRefresh={refresh} />
      {error ? <div className="global-error">{error}</div> : null}
      <OverviewCards overview={overview} />
      <div className="content-grid">
        <div className="main-column">
          <ResourcePanel overview={overview} onRefresh={refresh} />
          <MapPanel overview={overview} />
        </div>
        <div className="side-column">
          <section className="panel compact-panel">
            <div className="panel-header">
              <div>
                <h2>Welt</h2>
                <p>{serverState?.activeSessionName || 'Keine aktive Session'}</p>
              </div>
              <Activity size={20} />
            </div>
            <dl className="world-list">
              <div>
                <dt>Tech Tier</dt>
                <dd>{serverState?.techTier ?? '-'}</dd>
              </div>
              <div>
                <dt>Game Phase</dt>
                <dd>{serverState?.gamePhase || '-'}</dd>
              </div>
              <div>
                <dt>Schematic</dt>
                <dd>{serverState?.activeSchematic || '-'}</dd>
              </div>
              <div>
                <dt>Auto Load</dt>
                <dd>{serverState?.autoLoadSessionName || '-'}</dd>
              </div>
            </dl>
          </section>
          <UpdatePanel overview={overview} />
          <SavesPanel />
          <SettingsPanel overview={overview} onRefresh={refresh} />
        </div>
      </div>
    </div>
  );
}

export default App;
