'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const config = require('./config');

let appConfig = null;
let playbackWindow = null;
let currentPlayback = null;

function loadAppConfig() {
  appConfig = config.loadConfig();
}

function registerIpcHandlers() {
  ipcMain.handle('config:get', () => appConfig || config.loadConfig());
  ipcMain.handle('config:save', (_event, nextConfig) => {
    appConfig = config.saveConfig(nextConfig || {});
    return appConfig;
  });
  ipcMain.on('playback:ended', () => {
    if (!currentPlayback) return;
    currentPlayback.index += 1;
    playCurrentUrl();
  });
}

function getTodayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function findCardForToday(slot) {
  if (!appConfig) {
    appConfig = config.loadConfig();
  }
  const today = getTodayISO();
  if (!appConfig.cards || !Array.isArray(appConfig.cards)) return null;
  return appConfig.cards.find(
    (card) =>
      card &&
      card.date === today &&
      card.slot === slot &&
      Array.isArray(card.urls) &&
      card.urls.length > 0
  );
}

function createPlaybackWindow() {
  if (playbackWindow && !playbackWindow.isDestroyed()) {
    return playbackWindow;
  }

  playbackWindow = new BrowserWindow({
    width: 900,
    height: 600,
    show: false,
    title: 'YouTube Music Playback',
    webPreferences: {
      preload: path.join(__dirname, 'playback-preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  playbackWindow.on('closed', () => {
    playbackWindow = null;
  });

  return playbackWindow;
}

function broadcastCardsUpdate() {
  if (!appConfig || !Array.isArray(appConfig.cards)) return;
  BrowserWindow.getAllWindows().forEach((win) => {
    try {
      win.webContents.send('cards:updated', appConfig.cards);
    } catch (_) {
      // ignore
    }
  });
}

function startPlaybackForCard(card) {
  if (!card || !Array.isArray(card.urls) || !card.urls.length) return;

  const urls = card.urls.filter(Boolean);
  if (!urls.length) return;

  currentPlayback = {
    cardId: card.id,
    urls,
    index: 0
  };

  createPlaybackWindow();
  playCurrentUrl();
}

function playCurrentUrl() {
  if (!currentPlayback) return;
  const { urls, index } = currentPlayback;
  if (!urls || index >= urls.length) {
    finishPlayback();
    return;
  }

  const win = createPlaybackWindow();
  const url = urls[index];
  win.loadURL(url);
}

function finishPlayback() {
  if (!currentPlayback) return;

  if (!appConfig) {
    appConfig = config.loadConfig();
  }

  if (!Array.isArray(appConfig.cards)) {
    appConfig.cards = [];
  }

  const idx = appConfig.cards.findIndex((c) => c && c.id === currentPlayback.cardId);
  if (idx >= 0) {
    const nowIso = new Date().toISOString();
    appConfig.cards[idx] = {
      ...appConfig.cards[idx],
      status: 'played',
      playedAt: nowIso
    };
    appConfig = config.saveConfig(appConfig);
    broadcastCardsUpdate();
  }

  currentPlayback = null;

  if (playbackWindow && !playbackWindow.isDestroyed()) {
    playbackWindow.close();
  }
}

function scheduleNextRunForSlot(slot) {
  const now = new Date();
  const [hours, minutes] = slot.split(':').map((n) => parseInt(n, 10));
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hours,
    minutes,
    0,
    0
  );

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  const delay = next.getTime() - now.getTime();
  setTimeout(() => {
    try {
      const card = findCardForToday(slot);
      if (card) {
        startPlaybackForCard(card);
      }
    } finally {
      scheduleNextRunForSlot(slot);
    }
  }, delay);
}

function setupScheduling() {
  scheduleNextRunForSlot('09:30');
  scheduleNextRunForSlot('13:00');
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 900,
    minHeight: 600,
    title: 'YouTube Music Auto Player',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  loadAppConfig();
  registerIpcHandlers();
  setupScheduling();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
