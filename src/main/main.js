'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const http  = require('http');
const fs    = require('fs');
const cfg = require('./config');
const spotify = require('./spotify');
const spotifyAuth = require('./spotify-auth');

process.on('uncaughtException', (err) => {
  if (err.code === 'EIO' || (err.message && err.message.includes('EIO'))) return;
  console.error('Uncaught:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UnhandledRejection:', reason);
});

let appConfig = null;
let mainWin   = null;
let devServer = null;
let devPort   = 3942;

// ── Token management ──────────────────────────────────
async function ensureToken() {
  if (!appConfig.spotifyAccessToken) return null;
  const now = Date.now();
  if (appConfig.spotifyTokenExpiry && now < appConfig.spotifyTokenExpiry - 5 * 60 * 1000) {
    return appConfig.spotifyAccessToken;
  }
  if (appConfig.spotifyRefreshToken) {
    try {
      const tokens = await spotifyAuth.refreshAccessToken(
        appConfig.spotifyClientId,
        appConfig.spotifyClientSecret,
        appConfig.spotifyRefreshToken
      );
      appConfig.spotifyAccessToken = tokens.access_token;
      appConfig.spotifyTokenExpiry = Date.now() + (tokens.expires_in || 3600) * 1000;
      if (tokens.refresh_token) appConfig.spotifyRefreshToken = tokens.refresh_token;
      appConfig = cfg.saveConfig(appConfig);
    } catch (e) {
      console.error('Token refresh failed:', e.message);
    }
  }
  return appConfig.spotifyAccessToken || null;
}

async function withToken(fn) {
  let token = await ensureToken();
  if (!token) throw new Error('Chưa đăng nhập Spotify. Vào Cài đặt để đăng nhập.');
  try {
    return await fn(token);
  } catch (e) {
    if (e.statusCode === 401 && appConfig.spotifyRefreshToken) {
      appConfig.spotifyTokenExpiry = 0;
      token = await ensureToken();
      if (token) return await fn(token);
    }
    throw e;
  }
}

// ── Broadcast update to renderer ──────────────────────
function broadcast() {
  const loggedIn = !!(appConfig.spotifyAccessToken);
  BrowserWindow.getAllWindows().forEach(w => {
    try {
      w.webContents.send('playlists:updated', appConfig.playlists, {
        loggedIn,
        profile: appConfig.spotifyProfile || null
      });
    } catch {}
  });
}

// ── IPC handlers ──────────────────────────────────────
function registerIpc() {
  ipcMain.handle('config:get', () => ({
    playlists: appConfig.playlists,
    loggedIn: !!appConfig.spotifyAccessToken,
    clientId: appConfig.spotifyClientId,
    deviceId: appConfig.spotifyDeviceId,
    profile: appConfig.spotifyProfile || null,
    maxTracks: appConfig.maxTracks || 5
  }));

  ipcMain.handle('spotify:set-credentials', (_e, { clientId, clientSecret, deviceId, maxTracks }) => {
    if (clientId !== undefined) appConfig.spotifyClientId = clientId;
    if (clientSecret !== undefined) appConfig.spotifyClientSecret = clientSecret;
    if (deviceId !== undefined) appConfig.spotifyDeviceId = deviceId;
    if (maxTracks !== undefined) appConfig.maxTracks = maxTracks;
    appConfig = cfg.saveConfig(appConfig);
    return { ok: true };
  });

  ipcMain.handle('spotify:logout', () => {
    appConfig.spotifyAccessToken = '';
    appConfig.spotifyRefreshToken = '';
    appConfig.spotifyTokenExpiry = 0;
    appConfig.spotifyDeviceId = '';
    appConfig.spotifyProfile = null;
    appConfig = cfg.saveConfig(appConfig);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('spotify:login', async () => {
    if (!appConfig.spotifyClientId || !appConfig.spotifyClientSecret) {
      return { error: 'Nhập Client ID và Client Secret trong Cài đặt trước.' };
    }
    try {
      const tokens = await spotifyAuth.startOAuthFlow(
        appConfig.spotifyClientId,
        appConfig.spotifyClientSecret
      );
      appConfig.spotifyAccessToken = tokens.access_token;
      if (tokens.refresh_token) appConfig.spotifyRefreshToken = tokens.refresh_token;
      appConfig.spotifyTokenExpiry = Date.now() + (tokens.expires_in || 3600) * 1000;
      appConfig.spotifyScope = tokens.scope || '';
      appConfig = cfg.saveConfig(appConfig);

      // Fetch and save user profile
      try {
        const me = await spotify.getMe(tokens.access_token);
        appConfig.spotifyProfile = {
          displayName: me.display_name || me.id || '',
          avatarUrl: ((me.images || [])[0] || {}).url || '',
          profileUrl: ((me.external_urls || {}).spotify) || ''
        };
        appConfig = cfg.saveConfig(appConfig);
      } catch {}

      broadcast();
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('spotify:get-profile', async () => {
    try {
      const me = await withToken(t => spotify.getMe(t));
      const profile = {
        displayName: me.display_name || me.id || '',
        avatarUrl: ((me.images || [])[0] || {}).url || '',
        profileUrl: ((me.external_urls || {}).spotify) || ''
      };
      appConfig.spotifyProfile = profile;
      cfg.saveConfig(appConfig);
      return { profile };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('spotify:open-app', () => {
    shell.openExternal('spotify:').catch(() => {
      shell.openExternal('https://open.spotify.com');
    });
    return { ok: true };
  });

  ipcMain.handle('spotify:open-url', (_e, url) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
    return { ok: true };
  });

  ipcMain.handle('spotify:player-state', async () => {
    try {
      const state = await withToken(t => spotify.getPlayerState(t));
      return { state };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('spotify:playback-control', async (_e, action, data) => {
    try {
      await withToken(async token => {
        switch (action) {
          case 'pause':  await spotify.pausePlayback(token); break;
          case 'resume': await spotify.resumePlayback(token); break;
          case 'next':   await spotify.nextTrack(token); break;
          case 'prev':   await spotify.prevTrack(token); break;
          case 'seek':   await spotify.seekTo(token, data); break;
          case 'volume': await spotify.setVolume(token, data); break;
        }
      });
      return { ok: true };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('spotify:search', async (_e, query) => {
    try {
      const results = await withToken(token => spotify.searchTracks(token, query));
      return { results };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('spotify:resolve', async (_e, urlOrUri) => {
    try {
      const track = await withToken(token => spotify.getTrack(token, urlOrUri));
      return { track };
    } catch (e) {
      return { error: e.message };
    }
  });

  ipcMain.handle('playlist:save', (_e, playlist) => {
    if (!Array.isArray(appConfig.playlists)) appConfig.playlists = [];
    const idx = appConfig.playlists.findIndex(p => p.id === playlist.id);
    if (idx >= 0) appConfig.playlists[idx] = playlist;
    else appConfig.playlists.push(playlist);
    appConfig = cfg.saveConfig(appConfig);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('playlist:delete', (_e, id) => {
    appConfig.playlists = (appConfig.playlists || []).filter(p => p.id !== id);
    appConfig = cfg.saveConfig(appConfig);
    broadcast();
    return { ok: true };
  });

  ipcMain.handle('playlist:play', async (_e, id) => {
    const pl = (appConfig.playlists || []).find(p => p.id === id);
    if (!pl || !(pl.tracks || []).length) return { error: 'Playlist trống hoặc không tồn tại' };
    try {
      const uris = pl.tracks.map(t => t.spotifyUri);
      const result = await withToken(token =>
        spotify.playTracks(token, uris, appConfig.spotifyDeviceId || undefined)
      );
      if (result && result.usedDeviceId && result.usedDeviceId !== appConfig.spotifyDeviceId) {
        appConfig.spotifyDeviceId = result.usedDeviceId;
      }
      const idx = appConfig.playlists.findIndex(p => p.id === id);
      if (idx >= 0) {
        appConfig.playlists[idx].status = 'played';
        appConfig.playlists[idx].playedAt = new Date().toISOString();
      }
      appConfig = cfg.saveConfig(appConfig);
      broadcast();
      return { ok: true };
    } catch (e) {
      if (e.message.includes('404') || e.message.includes('Not found')) {
        appConfig.spotifyDeviceId = '';
        cfg.saveConfig(appConfig);
      }
      // Signal renderer to open Spotify and retry
      const noDevice = e.message.includes('Không tìm thấy') || e.message.includes('NO_ACTIVE_DEVICE');
      return { error: noDevice ? 'no_device' : e.message, message: e.message };
    }
  });

  ipcMain.handle('spotify:diagnose', async () => {
    try {
      const [me, devices, player] = await Promise.all([
        withToken(t => spotify.getMe(t)).catch(e => ({ error: e.message })),
        withToken(t => spotify.getDevices(t)).catch(() => []),
        withToken(t => spotify.getPlayerState(t)).catch(() => null)
      ]);
      return { me, devices, player };
    } catch (e) {
      return { error: e.message };
    }
  });
}

// ── Scheduler ─────────────────────────────────────────
function scheduleSlot(slot) {
  const [h, m] = slot.split(':').map(Number);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  console.log(`Scheduled ${slot} in ${Math.round(delay / 60000)} min`);
  setTimeout(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const pl = (appConfig.playlists || []).find(p => p.date === today && p.slot === slot && (p.tracks || []).length > 0);
      if (pl) {
        // Play via Spotify Connect API
        const uris = pl.tracks.map(t => t.spotifyUri);
        await withToken(token => spotify.playTracks(token, uris, appConfig.spotifyDeviceId || undefined))
          .catch(err => {
            console.error(`Auto-play ${slot} Connect failed:`, err.message);
            // Fallback: notify renderer to handle
            BrowserWindow.getAllWindows().forEach(w => {
              try { w.webContents.send('play:scheduled', pl.id); } catch {}
            });
          });
        const idx = appConfig.playlists.findIndex(p => p.id === pl.id);
        if (idx >= 0) {
          appConfig.playlists[idx].status = 'played';
          appConfig.playlists[idx].playedAt = new Date().toISOString();
          appConfig = cfg.saveConfig(appConfig);
          broadcast();
        }
        console.log(`Auto-play scheduled: ${pl.id}`);
      }
    } catch (e) {
      console.error(`Auto-play ${slot} failed:`, e.message);
    } finally {
      scheduleSlot(slot);
    }
  }, delay);
}

// ── Local HTTP server: static files only (audio via IPC/Blob) ──
function startDevServer(rendererDir) {
  return new Promise((resolve) => {
    const MIME = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css',
                   '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml' };

    devServer = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      const filePath = path.join(rendererDir, urlPath === '/' ? 'index.html' : urlPath);
      const ext = path.extname(filePath);
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });

    devServer.listen(devPort, '127.0.0.1', () => resolve(devPort));
    devServer.on('error', () => { devPort++; devServer.listen(devPort, '127.0.0.1', () => resolve(devPort)); });
  });
}

// ── Window ────────────────────────────────────────────
function createWindow(port) {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    title: 'Spotify Playlist Her',
    icon: path.join(__dirname, '../../image/icons8-spotify-100.png'),
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  mainWin.loadURL(`http://localhost:${port}/index.html`);
  mainWin.on('closed', () => { mainWin = null; });
}

// ── App lifecycle ─────────────────────────────────────
app.whenReady().then(async () => {
  appConfig = cfg.loadConfig();

  // Note: previously cleared tokens missing 'streaming' scope here,
  // but that caused a login loop. Token is now kept; SDK will report
  // auth errors if scope is insufficient.

  // Start local HTTP server so renderer runs on http://localhost (secure context for SDK)
  const rendererDir = path.join(__dirname, '../renderer');
  const port = await startDevServer(rendererDir);
  console.log(`Renderer served at http://localhost:${port}`);

  registerIpc();
  scheduleSlot('09:30');
  scheduleSlot('13:00');
  createWindow(port);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (devServer) devServer.close();
  if (process.platform !== 'darwin') app.quit();
});
