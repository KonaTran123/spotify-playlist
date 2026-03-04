'use strict';

const http  = require('http');
const https = require('https');
const { BrowserWindow } = require('electron');

// Register EXACTLY this in Spotify Dashboard → Settings → Redirect URIs
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-private'
].join(' ');

function startOAuthFlow(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id:     clientId,
      response_type: 'code',
      redirect_uri:  REDIRECT_URI,
      scope:         SCOPES,
      show_dialog:   'true',
      state:         Math.random().toString(36).slice(2) // prevent caching
    }).toString();

    let win = null;
    let settled = false;

    function done(fn) {
      if (settled) return;
      settled = true;
      try { server.close(); } catch {}
      try { if (win && !win.isDestroyed()) win.close(); } catch {}
      fn();
    }

    // ── HTTP server listens for the OAuth callback ──
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:8888`);
      if (url.pathname !== '/callback') { res.end(); return; }

      const code = url.searchParams.get('code');
      const err  = url.searchParams.get('error');

      // Respond with a nice page before closing
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>body{margin:0;display:flex;align-items:center;justify-content:center;
          height:100vh;font-family:sans-serif;background:#0d0d0d;color:#1DB954;text-align:center}
          h2{font-size:22px}p{color:#aaa;font-size:14px}</style></head><body>
        <div><h2>${err ? '✗ Thất bại' : '✓ Đăng nhập thành công!'}</h2>
        <p>${err ? err : 'Có thể đóng cửa sổ này.'}</p></div></body></html>`);

      if (err || !code) {
        done(() => reject(new Error('OAuth bị hủy: ' + (err || 'no code'))));
        return;
      }

      try {
        const tokens = await exchangeCode(clientId, clientSecret, code);
        done(() => resolve(tokens));
      } catch (e) {
        done(() => reject(e));
      }
    });

    server.on('error', (e) => {
      // Port in use — try to proceed without server (shouldn't happen normally)
      reject(new Error('Port 8888 đang bận: ' + e.message));
    });

    server.listen(8888, '127.0.0.1', () => {
      // ── Open Spotify login page in Electron window ──
      win = new BrowserWindow({
        width: 520,
        height: 740,
        title: 'Đăng nhập Spotify',
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration:  false,
          contextIsolation: true
        }
      });

      win.loadURL(authUrl);

      win.on('closed', () => {
        win = null;
        // Give the HTTP server 500ms to finish handling any in-flight callback
        setTimeout(() => {
          done(() => reject(new Error('Đã đóng cửa sổ đăng nhập')));
        }, 500);
      });
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      done(() => reject(new Error('Hết thời gian đăng nhập (5 phút)')));
    }, 5 * 60 * 1000);
  });
}

function exchangeCode(clientId, clientSecret, code) {
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri: REDIRECT_URI
  }).toString();
  return tokenRequest(clientId, clientSecret, body);
}

function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: refreshToken
  }).toString();
  return tokenRequest(clientId, clientSecret, body);
}

function tokenRequest(clientId, clientSecret, body) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const req = https.request({
      hostname: 'accounts.spotify.com',
      path:     '/api/token',
      method:   'POST',
      headers:  {
        Authorization:   `Basic ${auth}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (json.error) return reject(new Error(json.error_description || json.error));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { startOAuthFlow, refreshAccessToken };
