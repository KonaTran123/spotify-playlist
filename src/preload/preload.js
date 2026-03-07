'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spotifyApp', {
  getConfig:        ()          => ipcRenderer.invoke('config:get'),
  setCredentials:   (c)         => ipcRenderer.invoke('spotify:set-credentials', c),
  login:            ()          => ipcRenderer.invoke('spotify:login'),
  logout:           ()          => ipcRenderer.invoke('spotify:logout'),
  getProfile:       ()          => ipcRenderer.invoke('spotify:get-profile'),
  search:           (q)         => ipcRenderer.invoke('spotify:search', q),
  resolve:          (url)       => ipcRenderer.invoke('spotify:resolve', url),
  savePlaylist:     (pl)        => ipcRenderer.invoke('playlist:save', pl),
  deletePlaylist:   (id)        => ipcRenderer.invoke('playlist:delete', id),
  playPlaylist:     (id)        => ipcRenderer.invoke('playlist:play', id),
  diagnose:         ()          => ipcRenderer.invoke('spotify:diagnose'),
  playerState:      ()          => ipcRenderer.invoke('spotify:player-state'),
  playbackControl:  (act, data) => ipcRenderer.invoke('spotify:playback-control', act, data),
  openSpotify:      ()          => ipcRenderer.invoke('spotify:open-app'),
  openUrl:          (url)       => ipcRenderer.invoke('spotify:open-url', url),
  getToken:         ()          => ipcRenderer.invoke('spotify:get-token'),
  playUris:         (uris, did) => ipcRenderer.invoke('spotify:play-uris', { uris, deviceId: did }),
  onUpdate: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('playlists:updated', (_e, playlists, meta) => fn(playlists, meta));
  },
  onScheduledPlay: (fn) => {
    if (typeof fn !== 'function') return;
    ipcRenderer.on('play:scheduled', (_e, playlistId) => fn(playlistId));
  }
});

