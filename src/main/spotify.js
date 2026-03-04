'use strict';

const https = require('https');

function callSpotifyApi(accessToken, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.spotify.com',
      path: apiPath,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('SPOTIFY_TOKEN_EXPIRED');
          err.statusCode = 401;
          return reject(err);
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (!raw) return resolve(null);
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        } else {
          reject(new Error(`Spotify ${method} ${apiPath} → ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function parseTrackId(urlOrUri) {
  if (!urlOrUri) return null;
  if (urlOrUri.startsWith('spotify:track:')) return urlOrUri.slice('spotify:track:'.length);
  try {
    const u = new URL(urlOrUri);
    if (u.hostname.includes('open.spotify.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0] === 'track') return parts[1] || null;
    }
  } catch {}
  return null;
}

function isTrackUrl(str) { return !!parseTrackId(str); }

function trackToModel(item) {
  return {
    spotifyUri: item.uri,
    name: item.name,
    artist: (item.artists || []).map(a => a.name).join(', '),
    albumArt: ((item.album || {}).images || [])[0]?.url || null
  };
}

async function getTrack(accessToken, urlOrUri) {
  const id = parseTrackId(urlOrUri);
  if (!id) throw new Error('URL/URI Spotify không hợp lệ');
  const data = await callSpotifyApi(accessToken, 'GET', `/v1/tracks/${id}`);
  return trackToModel(data);
}

async function searchTracks(accessToken, query, limit = 6) {
  const data = await callSpotifyApi(
    accessToken, 'GET',
    `/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`
  );
  return ((data.tracks || {}).items || []).map(trackToModel);
}

async function getDevices(accessToken) {
  const data = await callSpotifyApi(accessToken, 'GET', '/v1/me/player/devices');
  return (data && data.devices) ? data.devices : [];
}

async function transferPlayback(accessToken, deviceId) {
  await callSpotifyApi(accessToken, 'PUT', '/v1/me/player', { device_ids: [deviceId], play: false });
  // Give Spotify 1s to register the transfer
  await new Promise(r => setTimeout(r, 1000));
}

async function playTracks(accessToken, uris, deviceId, _retry = false) {
  // If deviceId given, transfer playback then play
  if (deviceId) {
    try {
      // Transfer playback to target device first (makes it active)
      await callSpotifyApi(accessToken, 'PUT', '/v1/me/player',
        { device_ids: [deviceId], play: false });
      await new Promise(r => setTimeout(r, 800)); // wait for transfer
    } catch { /* ignore transfer errors, still try to play */ }

    try {
      await callSpotifyApi(accessToken, 'PUT',
        `/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`, { uris });
      return { usedDeviceId: deviceId };
    } catch (e) {
      // 404 = stale/invalid device ID — fall through to auto-pick
      if (!e.message.includes('404') && !e.message.includes('NO_ACTIVE_DEVICE') && !e.message.includes('Not found')) throw e;
    }
  }

  // Auto-pick first available device — retry up to 3x because SDK device
  // may take a few seconds to register with Spotify's servers after ready event
  let devices = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2500));
    devices = await getDevices(accessToken);
    if (devices.length) break;
    try { process.stdout.write(`getDevices attempt ${attempt + 1}: no devices yet, retrying...\n`); } catch {}
  }

  if (!devices.length) {
    throw new Error(
      'Không tìm thấy thiết bị Spotify nào.\n\n' +
      'Hãy làm theo các bước sau:\n' +
      '1. Mở app Spotify trên máy tính hoặc điện thoại\n' +
      '2. Phát bất kỳ bài hát nào\n' +
      '3. Quay lại đây và nhấn Phát ngay\n\n' +
      '(Hoặc vào ⚙ Cài đặt → nhấn 🔍 Chẩn đoán để chọn thiết bị)'
    );
  }

  // Prefer active device, else take first
  const target = devices.find(d => d.is_active) || devices[0];
  console.log('Auto-selected device:', target.name, target.id);

  await callSpotifyApi(accessToken, 'PUT',
    `/v1/me/player/play?device_id=${encodeURIComponent(target.id)}`, { uris });

  return { usedDeviceId: target.id };
}

async function pausePlayback(accessToken) {
  try { await callSpotifyApi(accessToken, 'PUT', '/v1/me/player/pause'); } catch {}
}

async function resumePlayback(accessToken) {
  try { await callSpotifyApi(accessToken, 'PUT', '/v1/me/player/play'); } catch {}
}

async function nextTrack(accessToken) {
  try { await callSpotifyApi(accessToken, 'POST', '/v1/me/player/next'); } catch {}
}

async function prevTrack(accessToken) {
  try { await callSpotifyApi(accessToken, 'POST', '/v1/me/player/previous'); } catch {}
}

async function seekTo(accessToken, positionMs) {
  try { await callSpotifyApi(accessToken, 'PUT', `/v1/me/player/seek?position_ms=${Math.round(positionMs)}`); } catch {}
}

async function setVolume(accessToken, volumePercent) {
  try { await callSpotifyApi(accessToken, 'PUT', `/v1/me/player/volume?volume_percent=${Math.round(volumePercent)}`); } catch {}
}

module.exports = { callSpotifyApi, isTrackUrl, getTrack, searchTracks, playTracks, getDevices, getPlayerState, getMe,
  pausePlayback, resumePlayback, nextTrack, prevTrack, seekTo, setVolume };

async function getPlayerState(accessToken) {
  try {
    return await callSpotifyApi(accessToken, 'GET', '/v1/me/player');
  } catch { return null; }
}

async function getMe(accessToken) {
  return await callSpotifyApi(accessToken, 'GET', '/v1/me');
}
