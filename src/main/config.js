'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// Load .env from project root (dev convenience)
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch {}

const DEFAULT = {
  playlists: [],
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  spotifyAccessToken: '',
  spotifyRefreshToken: '',
  spotifyDeviceId: '',
  spotifyTokenExpiry: 0,
  spotifyScope: '',
  spotifyProfile: null,  // { displayName, avatarUrl, profileUrl }
  maxTracks: 5
};

function cfgPath() {
  return path.join(app.getPath('userData'), 'spotify-auto-player.json');
}

function loadConfig() {
  const p = cfgPath();
  try {
    if (!fs.existsSync(p)) return { ...DEFAULT };
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...DEFAULT, ...raw, playlists: Array.isArray(raw.playlists) ? raw.playlists : [] };
  } catch (e) {
    console.error('Config load error:', e.message);
    return { ...DEFAULT };
  }
}

function saveConfig(cfg) {
  const p = cfgPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const out = { ...DEFAULT, ...cfg, playlists: Array.isArray(cfg.playlists) ? cfg.playlists : [] };
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

module.exports = { loadConfig, saveConfig };
