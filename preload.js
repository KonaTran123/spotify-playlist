'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytmAutoPlayer', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  onCardsUpdated: (handler) => {
    if (typeof handler !== 'function') return;
    const channel = 'cards:updated';
    ipcRenderer.on(channel, (_event, cards) => handler(cards));
  }
});
