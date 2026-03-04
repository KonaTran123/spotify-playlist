'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getConfigPath() {
  const userData = app.getPath('userData');
  return path.join(userData, 'ytm-auto-player-config.json');
}

const defaultConfig = {
  cards: []
};

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadConfig() {
  const configPath = getConfigPath();

  try {
    if (!fs.existsSync(configPath)) {
      ensureDirExists(configPath);
      fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf8');
      return { ...defaultConfig };
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    return {
      ...defaultConfig,
      ...parsed,
      cards: Array.isArray(parsed.cards) ? parsed.cards : []
    };
  } catch (error) {
    console.error('Failed to load config file:', error);
    return { ...defaultConfig };
  }
}

function saveConfig(config) {
  const configPath = getConfigPath();
  const payload = {
    ...defaultConfig,
    ...config,
    cards: Array.isArray(config.cards) ? config.cards : []
  };

  ensureDirExists(configPath);
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

module.exports = {
  getConfigPath,
  loadConfig,
  saveConfig
};
