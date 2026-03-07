'use strict';

const api = window.spotifyApp;

// ── State ──
let state = {
  playlists: [],
  loggedIn: false,
  clientId: '',
  profile: null,
  activePlaylistId: null,
  currentTrackUri: null,
  filter: { type: 'all', date: null, slot: null },  // 'all' = no filter
  view: 'grid',  // 'grid' | 'day'
  maxTracks: 5
};

// ── Spotify Web Playback SDK ─────────────────────────────────
let sdkPlayer   = null;
let sdkDeviceId = null;
let sdkLoaded   = false;

// Stream modal state
const stream = {
  open:        false,
  playlistId:  null,
  tracks:      [],
  currentUri:  null,
  playedUris:  new Set(),
  posMs:       0,
  durMs:       0,
  playing:     false,
  rafId:       null,
  rafBaseTs:   0,
  rafBasePos:  0
};

window.onSpotifyWebPlaybackSDKReady = () => {
  sdkLoaded = true;
  if (state.loggedIn) initSdkPlayer();
};

async function initSdkPlayer() {
  if (sdkPlayer || !sdkLoaded) return;
  const tokenRes = await api.getToken().catch(() => ({}));
  if (!tokenRes || !tokenRes.token) return;

  sdkPlayer = new Spotify.Player({
    name: 'Cadence',
    getOAuthToken: async (cb) => {
      const r = await api.getToken().catch(() => ({}));
      cb(r.token || '');
    },
    volume: 0.8
  });

  sdkPlayer.addListener('ready', ({ device_id }) => {
    sdkDeviceId = device_id;
    console.log('Cadence SDK ready, device:', device_id);
  });
  sdkPlayer.addListener('not_ready', () => { sdkDeviceId = null; });
  sdkPlayer.addListener('initialization_error', ({ message }) => {
    console.error('SDK init error:', message); sdkPlayer = null;
  });
  sdkPlayer.addListener('authentication_error', ({ message }) => {
    console.error('SDK auth error:', message);
    if (stream.open) showStreamError('Cần tài khoản Spotify Premium để phát nhạc trong app.');
  });
  sdkPlayer.addListener('account_error', ({ message }) => {
    console.error('SDK account error:', message);
    if (stream.open) showStreamError('Cần tài khoản Spotify Premium để phát nhạc trong app.');
  });
  sdkPlayer.addListener('player_state_changed', onSdkStateChange);
  sdkPlayer.connect();
}

// ── Spotify Connect Player ──
let pollInterval = null;
let lastPlayerUri = null;   // track URI currently showing in player bar

function fmtTime(ms) {
  if (!ms || isNaN(ms)) return '0:00';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollPlayerState, 3000);
  pollPlayerState(); // immediate
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
}

const EQ_HTML = `<span class="eq-bars"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>`;
const TRACK_EQ_HTML = `<span class="track-row-eq"><span class="disc-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg></span></span>`;

function updateNowPlayingIndicators() {
  document.querySelectorAll('.pl-card').forEach(card => {
    const id = card.dataset.id;
    const pl = state.playlists.find(p => p.id === id);
    const isActive = id === state.activePlaylistId;
    const isNP = isActive && !!state.currentTrackUri;
    card.classList.toggle('card-active', isActive);

    // Update badge
    const badgeEl = card.querySelector('.badge');
    if (badgeEl) {
      if (isNP) {
        badgeEl.className = 'badge badge-playing';
        badgeEl.innerHTML = EQ_HTML + ' Đang phát';
      } else if (pl && pl.status === 'played') {
        badgeEl.className = 'badge badge-played';
        badgeEl.innerHTML = 'Đã phát';
      } else {
        badgeEl.className = 'badge badge-pending';
        badgeEl.innerHTML = 'Chưa phát';
      }
    }

    // Update play/stop button dynamically
    const actionBtn = card.querySelector('.play-btn, .stop-btn');
    if (actionBtn) {
      if (isNP) {
        actionBtn.className = 'card-stop-btn stop-btn';
        actionBtn.innerHTML = '⏹ Dừng';
        actionBtn.disabled = false;
        const newBtn = actionBtn.cloneNode(true);
        newBtn.addEventListener('click', () => handleStop(id));
        actionBtn.replaceWith(newBtn);
      } else {
        actionBtn.className = 'card-play-btn play-btn';
        actionBtn.innerHTML = '▶ Phát ngay';
        actionBtn.disabled = false;
        const newBtn = actionBtn.cloneNode(true);
        newBtn.addEventListener('click', () => {
          if (!(pl && (pl.tracks || []).length)) { openMusicModal(id); return; }
          handlePlay(id);
        });
        actionBtn.replaceWith(newBtn);
      }
    }

    // Disable manage-music-btn while playing → handled by click listener (shows warning)

    // Update track rows — highlight currently playing track
    if (!pl) return;
    card.querySelectorAll('.track-row').forEach((row, idx) => {
      const track = (pl.tracks || [])[idx];
      const isCurrentTrack = state.currentTrackUri && track && track.spotifyUri === state.currentTrackUri;
      row.classList.toggle('now-playing', !!isCurrentTrack);
      const existingEq = row.querySelector('.track-row-eq');
      if (existingEq) existingEq.remove();
      if (isCurrentTrack) {
        const eqEl = document.createElement('span');
        eqEl.className = 'track-row-eq';
        eqEl.innerHTML = '<span class="disc-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 14.5c-2.49 0-4.5-2.01-4.5-4.5S9.51 7.5 12 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5zm0-5.5c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1z"/></svg></span>';
        const info = row.querySelector('.track-info');
        if (info) info.after(eqEl);
      }
    });
  });
}

async function pollPlayerState() {
  if (!state.loggedIn) return;
  const res = await api.playerState().catch(() => ({}));
  const ps = res && res.state;
  if (!ps || !ps.item) {
    updatePlayerBarIdle();
    return;
  }
  const item = ps.item;
  const isPlaying = ps.is_playing;
  const progress = ps.progress_ms || 0;
  const duration = item.duration_ms || 0;

  updatePlayerBarTrack({
    name: item.name,
    artist: (item.artists || []).map(a => a.name).join(', '),
    albumArt: ((item.album || {}).images || [])[0]?.url || null,
    uri: item.uri,
    isPlaying,
    progress,
    duration
  });
}

function updatePlayerBarIdle() {
  // Playlist completion: if still tracking an active playlist, mark it as played
  if (state.activePlaylistId) {
    const pl = state.playlists.find(p => p.id === state.activePlaylistId);
    if (pl && pl.status !== 'played') {
      pl.status = 'played';
      pl.playedAt = new Date().toISOString();
      savePlaylist(pl); // fire & forget
    }
    state.activePlaylistId = null;
    if (pl) rerenderCard(pl);
  }
  const bar = document.getElementById('player-bar');
  if (bar && !bar.classList.contains('hidden')) {
    bar.classList.add('hiding');
    setTimeout(() => {
      bar.classList.remove('hiding');
      bar.classList.add('hidden');
    }, 400);
  }
  state.currentTrackUri = null;
  updateNowPlayingIndicators();
  updatePlayPauseUI(false);
}

function updatePlayerBarTrack({ name, artist, albumArt, uri, isPlaying, progress, duration }) {
  const bar = document.getElementById('player-bar');
  if (bar) bar.classList.remove('hidden');

  // Track URI change → update now-playing indicators on cards
  if (uri !== state.currentTrackUri) {
    state.currentTrackUri = uri;
    updateNowPlayingIndicators();
  }

  const nameEl   = document.getElementById('pb-track-name');
  const artistEl = document.getElementById('pb-artist');
  const artOuter = document.getElementById('pb-art-outer');
  if (nameEl) { nameEl.textContent = name || '—'; nameEl.className = 'pb-track'; }
  if (artistEl) { artistEl.textContent = artist || ''; artistEl.classList.toggle('hidden', !artist); }
  if (artOuter) {
    artOuter.innerHTML = albumArt
      ? `<img class="pb-art${isPlaying ? ' spinning' : ''}" src="${albumArt}" alt="" />`
      : `<div class="pb-art-ph"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;
  }

  // Progress
  const pct = duration > 0 ? Math.min((progress / duration) * 100, 100) : 0;
  const fill  = document.getElementById('pb-bar-fill');
  const thumb = document.getElementById('pb-bar-thumb');
  const curEl = document.getElementById('pb-current');
  const totEl = document.getElementById('pb-total');
  if (fill)  fill.style.width = pct + '%';
  if (thumb) thumb.style.left = 'calc(' + pct + '% - 6px)';
  if (curEl) curEl.textContent = fmtTime(progress);
  if (totEl) totEl.textContent = fmtTime(duration);

  updatePlayPauseUI(isPlaying);

  // Prev/Next visibility — based on track position in active playlist
  const prevBtn = document.getElementById('pb-prev');
  const nextBtn = document.getElementById('pb-next');
  if (prevBtn && nextBtn) {
    const activePl = state.activePlaylistId
      ? state.playlists.find(p => p.id === state.activePlaylistId)
      : null;
    if (activePl && (activePl.tracks || []).length > 0) {
      const idx = activePl.tracks.findIndex(t => t.uri === uri);
      prevBtn.disabled = idx <= 0;
      nextBtn.disabled = idx >= activePl.tracks.length - 1;
    } else {
      prevBtn.disabled = false;
      nextBtn.disabled = false;
    }
  }
}

function updatePlayPauseUI(playing) {
  const playIcon  = document.getElementById('pb-play-icon');
  const pauseIcon = document.getElementById('pb-pause-icon');
  const playBtn   = document.getElementById('pb-playpause');
  if (playIcon)  playIcon.style.display  = playing ? 'none' : '';
  if (pauseIcon) pauseIcon.style.display = playing ? '' : 'none';
  if (playBtn)   playBtn.classList.toggle('playing', playing);
  const artEl    = document.querySelector('.pb-art');
  const artOuter = document.getElementById('pb-art-outer');
  if (artEl)    artEl.classList.toggle('spinning', playing);
  if (artOuter) artOuter.classList.toggle('playing', playing);
  const eq = document.getElementById('pb-eq');
  if (eq) eq.classList.toggle('active', playing);
}

// ── Helpers ──
function todayISO() { return new Date().toISOString().slice(0, 10); }

// Show a small tooltip "Dừng nhạc khi thực hiện" near the target button
let _warningTimer = null;
function showPlayingWarning(targetEl) {
  const existing = document.getElementById('playing-warning-tip');
  if (existing) existing.remove();
  clearTimeout(_warningTimer);

  const tip = document.createElement('div');
  tip.id = 'playing-warning-tip';
  tip.textContent = '⏸ Dừng nhạc khi thực hiện';
  document.body.appendChild(tip);

  const rect = targetEl.getBoundingClientRect();
  tip.style.cssText = `position:fixed;bottom:${window.innerHeight - rect.top + 6}px;left:${rect.left}px;
    background:#1e1e1e;color:#fff;font-size:11px;font-weight:500;padding:5px 10px;
    border-radius:7px;border:1px solid rgba(255,255,255,0.12);box-shadow:0 4px 16px rgba(0,0,0,0.5);
    white-space:nowrap;z-index:99999;pointer-events:none;
    animation:fadeIn 120ms ease`;

  _warningTimer = setTimeout(() => tip.remove(), 2500);
}

function formatDateVN(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function isSpotifyTrackUrl(str) {
  if (!str) return false;
  return str.startsWith('spotify:track:') ||
    (str.includes('open.spotify.com') && str.includes('/track/'));
}

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function offsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDateVNShort(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// ── Filter ──
function setFilter(type, customDate) {
  state.filter.type = type;
  if (type === 'all')         state.filter.date = null;
  else if (type === 'today')  state.filter.date = todayISO();
  else if (type === 'custom') state.filter.date = customDate || todayISO();

  // Highlight active date button
  ['all','today'].forEach(t => {
    const btn = document.getElementById('filter-' + t);
    if (btn) btn.classList.toggle('active', t === type);
  });
  const customBtn = document.getElementById('filter-custom-btn');
  if (customBtn) {
    customBtn.classList.toggle('active', type === 'custom');
    const label = document.getElementById('filter-custom-label');
    if (label) label.textContent = type === 'custom' && customDate
      ? formatDateVNShort(customDate)
      : 'Chọn ngày';
  }

  renderAll();
}

function getFilteredPlaylists() {
  let result = state.playlists;
  // Apply date filter
  const { date, slot } = state.filter;
  if (date) result = result.filter(p => p.date === date);
  // Apply slot filter (independent, combinable)
  if (slot) result = result.filter(p => p.slot === slot);
  return result;
}

function updateFilterCount(filtered, total) {
  const el = document.getElementById('filter-count');
  if (!el) return;
  if (filtered === total) {
    el.textContent = `${total} playlist`;
  } else {
    el.textContent = `${filtered} / ${total}`;
  }
}

function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Save helpers ──
async function savePlaylist(playlist) { if (api) await api.savePlaylist(playlist); }
async function deletePlaylist(id) { if (api) await api.deletePlaylist(id); }

// ── Profile UI ──
function updateLoginUI(loggedIn, profile) {
  state.loggedIn = loggedIn;
  state.profile = profile || null;

  const pill      = document.getElementById('login-status');
  const loginBtn  = document.getElementById('login-btn');
  const userMenu  = document.getElementById('user-menu');

  if (loggedIn) {
    pill.textContent = '✓ Đã kết nối Spotify';
    pill.className   = 'status-pill on';
    loginBtn.classList.add('hidden');
    userMenu.classList.remove('hidden');
    applyProfile(profile);
    startPolling();
    // Init Spotify Web Playback SDK after login
    if (sdkLoaded) initSdkPlayer();
  } else {
    pill.textContent = '⚠ Chưa đăng nhập';
    pill.className   = 'status-pill off';
    loginBtn.classList.remove('hidden');
    userMenu.classList.add('hidden');
    stopPolling();
    updatePlayerBarIdle();
  }
}

function applyProfile(profile) {
  if (!profile) return;
  const name = profile.displayName || 'Spotify';
  const initials = name.charAt(0).toUpperCase();

  // Header avatar
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-avatar-ph').textContent = initials;
  document.getElementById('dd-avatar-ph').textContent = initials;
  document.getElementById('dd-name').textContent = name;

  if (profile.avatarUrl) {
    const img = document.getElementById('user-avatar');
    const ph  = document.getElementById('user-avatar-ph');
    const ddImg = document.getElementById('dd-avatar');
    const ddPh  = document.getElementById('dd-avatar-ph');
    img.src = profile.avatarUrl;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
    ddImg.src = profile.avatarUrl;
    ddImg.classList.remove('hidden');
    ddPh.classList.add('hidden');
  }
}

// ── Render ──
function renderAll() {
  const grid = document.getElementById('playlists-grid');
  grid.innerHTML = '';

  const filtered = getFilteredPlaylists();
  updateFilterCount(filtered.length, state.playlists.length);

  if (!filtered.length) {
    grid.classList.remove('day-view');
    const isEmpty = !state.playlists.length;
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
        </svg>
        <p>${isEmpty
          ? 'Chưa có playlist nào.<br/>Chọn ngày và giờ rồi nhấn <strong>+ Tạo</strong> để bắt đầu.'
          : 'Không có playlist nào trong ngày này.'}</p>
      </div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) =>
    a.date === b.date ? a.slot.localeCompare(b.slot) : a.date.localeCompare(b.date)
  );

  if (state.view === 'day') {
    grid.classList.add('day-view');
    renderDayView(grid, sorted);
  } else {
    grid.classList.remove('day-view');
    for (const pl of sorted) grid.appendChild(buildCard(pl));
  }
}

function renderDayView(grid, sorted) {
  const today = todayISO();
  const byDate = {};
  for (const pl of sorted) {
    if (!byDate[pl.date]) byDate[pl.date] = [];
    byDate[pl.date].push(pl);
  }
  for (const [date, playlists] of Object.entries(byDate).sort()) {
    // Date header
    const dateHdr = document.createElement('div');
    dateHdr.className = 'day-view-date-header';
    const isToday = date === today;
    const [y, m, d] = date.split('-');
    dateHdr.innerHTML = `
      <span class="dvdh-dot"></span>
      <span>${d}/${m}/${y}</span>
      ${isToday ? '<span class="dvdh-today">Hôm nay</span>' : ''}`;
    grid.appendChild(dateHdr);

    // All cards for this date in one row, sorted by slot (9h30 first)
    const rowCards = [...playlists].sort((a, b) => a.slot.localeCompare(b.slot));
    const body = document.createElement('div');
    body.className = 'day-view-slot-body';
    for (const pl of rowCards) body.appendChild(buildCard(pl));
    grid.appendChild(body);
  }
}

function buildCard(pl) {
  const card = document.createElement('article');
  const isMorning = pl.slot === '09:30';
  card.className = `pl-card${pl.status === 'played' ? ' played' : ''} ${isMorning ? 'slot-morning' : 'slot-noon'}`;
  card.dataset.id = pl.id;

  const slotLabel = isMorning ? '9h30' : '13h00';
  // Clean SVG pill tags — no emoji
  const slotIcon = isMorning
    ? `<span class="slot-tag morning">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 11H1v2h3v-2zm9-9h-2v2.96h2V2zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zM20 11v2h3v-2h-3zm-2 .5c0-3.31-2.69-6-6-6s-6 2.69-6 6 2.69 6 6 6 6-2.69 6-6zm-13 8h3v-2H5v2zm8 0h3v-2h-3v2zm8 0h3v-2h-3v2z"/></svg>
        Sáng
      </span>`
    : `<span class="slot-tag noon">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0-.39.39-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0 .39-.39.39-1.03 0-1.41l-1.06-1.06zm1.06-10.96c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06zM7.05 18.36c.39-.39.39-1.03 0-1.41-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06z"/></svg>
        Trưa
      </span>`;
  const isActive = state.activePlaylistId === pl.id;
  const isNowPlaying = isActive && !!state.currentTrackUri;
  const max = state.maxTracks;

  const badgeClass = isNowPlaying ? 'badge-playing' : pl.status === 'played' ? 'badge-played' : 'badge-pending';
  const badgeContent = isNowPlaying ? (EQ_HTML + ' Đang phát') : pl.status === 'played' ? 'Đã phát' : 'Chưa phát';
  const badge = `<span class="badge ${badgeClass}" data-id="${pl.id}">${badgeContent}</span>`;
  card.className = `pl-card${pl.status === 'played' ? ' played' : ''} ${isMorning ? 'slot-morning' : 'slot-noon'}${isActive ? ' card-active' : ''}`;

  // Header — slot info + delete button (dashed border)
  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `
    <div class="card-title">
      <div style="display:flex;align-items:center;gap:6px">
        ${slotIcon}
        <div class="card-slot">${slotLabel}</div>
      </div>
      <div class="card-date">${formatDateVN(pl.date)}</div>
    </div>
    <button class="card-del-btn del-btn" data-id="${pl.id}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
      Xóa
    </button>`;

  // Tracks list
  const trackList = document.createElement('div');
  trackList.className = 'tracks';
  trackList.id = `tracks-${pl.id}`;

  (pl.tracks || []).forEach((track, idx) => {
    trackList.appendChild(buildTrackRow(track, pl, idx, isActive));
  });

  // No drag-drop on card — drag-drop is in the music modal

  // Actions row: badge (50%) + play/stop btn (50%), above footer
  const actionsRow = document.createElement('div');
  actionsRow.className = 'card-actions-row';
  actionsRow.innerHTML = isNowPlaying
    ? `${badge}<button class="card-stop-btn stop-btn" data-id="${pl.id}">⏹ Dừng</button>`
    : `${badge}<button class="card-play-btn play-btn" data-id="${pl.id}">▶ Phát ngay</button>`;

  // Footer: manage music button + toggle played button
  const footer = document.createElement('div');
  footer.className = 'card-footer';
  const count = (pl.tracks || []).length;
  const isFull = count >= max;
  const isPlayed = pl.status === 'played';
  footer.innerHTML = `
    <button class="manage-music-btn" data-id="${pl.id}">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
      Quản lý nhạc
      <span class="count-badge${isFull ? ' full' : ''}">${count}/${max}</span>
    </button>
    <button class="card-toggle-played-btn toggle-played-btn" data-id="${pl.id}" title="${isPlayed ? 'Đánh dấu chưa phát' : 'Đánh dấu đã phát'}">
      ${isPlayed ? '↩ Chưa phát' : '✓ Đã phát'}
    </button>`;

  card.appendChild(head);
  card.appendChild(trackList);
  card.appendChild(actionsRow);
  card.appendChild(footer);

  const badgeEl = actionsRow.querySelector('.badge');
  badgeEl?.addEventListener('click', () => {
    if (pl.status === 'played' || isNowPlaying) return;
    if (!(pl.tracks || []).length) { openMusicModal(pl.id); return; }
    handlePlay(pl.id);
  });
  if (isNowPlaying) {
    actionsRow.querySelector('.stop-btn')?.addEventListener('click', () => handleStop(pl.id));
  } else {
    actionsRow.querySelector('.play-btn')?.addEventListener('click', () => {
      if (!(pl.tracks || []).length) { openMusicModal(pl.id); return; }
      handlePlay(pl.id);
    });
  }
  card.querySelector('.del-btn').addEventListener('click', () => {
    if (isNowPlaying) { showPlayingWarning(card.querySelector('.del-btn')); return; }
    handleDelete(pl.id);
  });
  card.querySelector('.manage-music-btn').addEventListener('click', () => {
    if (isNowPlaying) { showPlayingWarning(card.querySelector('.manage-music-btn')); return; }
    openMusicModal(pl.id);
  });
  card.querySelector('.toggle-played-btn').addEventListener('click', () => {
    if (isNowPlaying) { showPlayingWarning(card.querySelector('.toggle-played-btn')); return; }
    const playlist = state.playlists.find(p => p.id === pl.id);
    if (!playlist) return;
    playlist.status = playlist.status === 'played' ? 'pending' : 'played';
    savePlaylist(playlist);
    rerenderCard(pl.id);
  });

  return card;
}

function buildTrackRow(track, pl, idx, isActive) {
  const row = document.createElement('div');
  row.className = 'track-row';
  row.dataset.idx = idx;

  const isCurrentTrack = isActive && state.currentTrackUri && track.spotifyUri === state.currentTrackUri;
  if (isCurrentTrack) row.classList.add('now-playing');

  const artHtml = track.albumArt
    ? `<img class="track-art" src="${track.albumArt}" alt="" loading="lazy" />`
    : `<div class="track-art-ph"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;

  const eqBars = isCurrentTrack ? TRACK_EQ_HTML : '';

  row.innerHTML = `
    ${artHtml}
    <div class="track-info">
      <div class="track-name">${escHtml(track.name)}</div>
      <div class="track-artist">${escHtml(track.artist)}</div>
    </div>
    ${eqBars}`;

  return row;
}

// ── Drag-and-Drop ──
function setupDragDrop(container, pl) {
  let dragSrcIdx = null;
  let dragOverIdx = null;

  const rows = () => [...container.querySelectorAll('.track-row[draggable]')];

  container.addEventListener('dragstart', e => {
    const row = e.target.closest('.track-row');
    if (!row) return;
    dragSrcIdx = parseInt(row.dataset.idx);
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragend', e => {
    const row = e.target.closest('.track-row');
    if (row) row.classList.remove('dragging');
    container.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
    dragSrcIdx = null;
    dragOverIdx = null;
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.track-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx);
    if (idx !== dragOverIdx) {
      container.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
      if (idx !== dragSrcIdx) row.classList.add('drag-over');
      dragOverIdx = idx;
    }
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('.track-row');
    if (!row || dragSrcIdx === null) return;
    const dropIdx = parseInt(row.dataset.idx);
    if (dropIdx === dragSrcIdx) return;

    // Reorder data
    const tracks = [...(pl.tracks || [])];
    const [removed] = tracks.splice(dragSrcIdx, 1);
    tracks.splice(dropIdx, 0, removed);
    pl.tracks = tracks;

    // Reorder DOM rows directly — no full card rebuild, no jank
    const allRows = [...container.querySelectorAll('.track-row')];
    const srcEl = allRows[dragSrcIdx];
    const destEl = allRows[dropIdx];
    if (dragSrcIdx < dropIdx) {
      container.insertBefore(srcEl, destEl.nextSibling);
    } else {
      container.insertBefore(srcEl, destEl);
    }
    // Update data-idx on all rows
    [...container.querySelectorAll('.track-row')].forEach((r, i) => { r.dataset.idx = i; });

    savePlaylist(pl); // save in background, no re-render
  });
}

// ── Actions ──
async function handlePlay(id) {
  return openStreamModal(id);
}

async function handleStop(id) {
  if (stream.open) { closeStreamModal(); return; }
  const pl = state.playlists.find(p => p.id === id);
  if (pl && pl.status !== 'played') {
    pl.status = 'played';
    pl.playedAt = new Date().toISOString();
    savePlaylist(pl);
  }
  await api.playbackControl('pause');
  state.activePlaylistId = null;
  state.currentTrackUri = null;
  const bar = document.getElementById('player-bar');
  if (bar && !bar.classList.contains('hidden')) {
    bar.classList.add('hiding');
    setTimeout(() => { bar.classList.remove('hiding'); bar.classList.add('hidden'); }, 400);
  }
  updateNowPlayingIndicators();
  updatePlayPauseUI(false);
  if (pl) rerenderCard(pl);
}

async function handleDelete(id) {
  state.playlists = state.playlists.filter(p => p.id !== id);
  if (state.activePlaylistId === id) state.activePlaylistId = null;
  await deletePlaylist(id);
  const card = document.querySelector(`.pl-card[data-id="${id}"]`);
  if (card) card.remove();
  if (!state.playlists.length) renderAll();
}

function rerenderCard(pl) {
  const old = document.querySelector(`.pl-card[data-id="${pl.id}"]`);
  if (!old) return;
  const updated = state.playlists.find(p => p.id === pl.id);
  if (!updated) return;
  const newCard = buildCard(updated);
  old.replaceWith(newCard);
}

// ── Stream Modal ─────────────────────────────────────────────

async function openStreamModal(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl || !(pl.tracks || []).length) { openMusicModal(id); return; }
  if (!state.loggedIn) { alert('Vui lòng đăng nhập Spotify trước.'); return; }

  // Init SDK if not yet done
  if (!sdkPlayer) await initSdkPlayer();

  // Reset stream state
  stream.open        = true;
  stream.playlistId  = id;
  stream.tracks      = [...(pl.tracks || [])];
  stream.currentUri  = null;
  stream.playedUris  = new Set();
  stream.posMs       = 0;
  stream.durMs       = 0;
  stream.playing     = false;

  // Show modal immediately, hide bottom bar
  document.getElementById('stream-modal').classList.remove('hidden');
  const bar = document.getElementById('player-bar');
  if (bar) bar.classList.add('hidden');
  stopPolling();

  // Render tracklist
  renderStreamTracklist();
  // Show loading state while SDK device registers
  showStreamLoading();

  // Wait for SDK device (up to 6s), then play
  let waited = 0;
  while (!sdkDeviceId && waited < 6000) {
    await new Promise(r => setTimeout(r, 250));
    waited += 250;
  }
  if (!stream.open) return; // user closed while waiting

  if (!sdkDeviceId) {
    showStreamError('Không khởi động được trình phát.<br>Tài khoản Spotify Premium là bắt buộc để phát nhạc trong ứng dụng.');
    return;
  }

  const uris = stream.tracks.map(t => t.spotifyUri);
  const res  = await api.playUris(uris, sdkDeviceId);
  if (res && res.error) {
    if (!stream.open) return;
    showStreamError('Lỗi phát nhạc: ' + escHtml(res.error));
  }
}

function closeStreamModal() {
  if (!stream.open) return;
  stream.open = false;
  if (stream.rafId) { cancelAnimationFrame(stream.rafId); stream.rafId = null; }

  // Pause SDK
  if (sdkPlayer) sdkPlayer.pause().catch(() => {});

  // Mark card as played
  if (stream.playlistId) {
    const pl = state.playlists.find(p => p.id === stream.playlistId);
    if (pl) {
      pl.status    = 'played';
      pl.playedAt  = new Date().toISOString();
      state.activePlaylistId = null;
      state.currentTrackUri  = null;
      savePlaylist(pl);
      rerenderCard(pl);
    }
  }

  // Reset & close
  document.getElementById('stream-modal').classList.add('hidden');
  stream.playlistId = null;
  stream.tracks     = [];
  stream.currentUri = null;
  stream.playedUris = new Set();
  updateNowPlayingIndicators();
}

function showStreamLoading() {
  const artWrap = document.getElementById('stream-art-wrap');
  const nameEl  = document.getElementById('stream-track-name');
  const artEl   = document.getElementById('stream-track-artist');
  if (artWrap) artWrap.innerHTML = `<div class="stream-art-ph"><div class="stream-spinner"></div></div>`;
  if (nameEl)  nameEl.textContent = 'Đang kết nối…';
  if (artEl)   artEl.textContent  = '';
}

function showStreamError(html) {
  const artWrap = document.getElementById('stream-art-wrap');
  const info    = document.querySelector('#stream-modal .stream-info');
  const prog    = document.querySelector('#stream-modal .stream-progress-row');
  const ctrl    = document.querySelector('#stream-modal .stream-controls');
  if (artWrap)  artWrap.innerHTML = `<div class="stream-art-ph"><svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg></div>`;
  if (info)     info.innerHTML  = `<div class="stream-error"><h3>Không thể phát</h3><p>${html}</p></div>`;
  if (prog)     prog.style.display = 'none';
  if (ctrl)     ctrl.style.display = 'none';
}

function onSdkStateChange(sdkState) {
  if (!stream.open || !sdkState) return;

  const currentTrack = sdkState.track_window && sdkState.track_window.current_track;
  if (!currentTrack) return;

  const newUri = currentTrack.uri;

  // Mark previous tracks as played (SDK gives us the list)
  (sdkState.track_window.previous_tracks || []).forEach(t => {
    if (stream.tracks.some(tr => tr.spotifyUri === t.uri)) stream.playedUris.add(t.uri);
  });

  // Track change: mark old current as played
  if (stream.currentUri && newUri !== stream.currentUri) {
    stream.playedUris.add(stream.currentUri);
  }
  stream.currentUri  = newUri;
  stream.posMs       = sdkState.position;
  stream.durMs       = currentTrack.duration_ms;
  stream.playing     = !sdkState.paused;
  stream.rafBaseTs   = Date.now();
  stream.rafBasePos  = sdkState.position;

  updateStreamTrack(currentTrack);
  renderStreamTracklist();
  updateStreamPlayPause(!sdkState.paused);

  // Update prev/next buttons
  const prevBtn = document.getElementById('stream-prev');
  const nextBtn = document.getElementById('stream-next');
  if (prevBtn) prevBtn.disabled = !(sdkState.track_window.previous_tracks || []).length;
  if (nextBtn) nextBtn.disabled = !(sdkState.track_window.next_tracks || []).length;

  // Auto-close when last track finished: paused at pos 0 with no next tracks
  if (sdkState.paused && sdkState.position === 0 &&
      !(sdkState.track_window.next_tracks || []).length &&
      stream.currentUri) {
    stream.playedUris.add(stream.currentUri);
    setTimeout(() => { if (stream.open) closeStreamModal(); }, 1200);
  }

  // Start RAF progress animation
  startStreamProgress();
}

function updateStreamTrack(track) {
  const artWrap = document.getElementById('stream-art-wrap');
  const nameEl  = document.getElementById('stream-track-name');
  const artistEl = document.getElementById('stream-track-artist');
  const totEl   = document.getElementById('stream-tot');
  const bgEl    = document.getElementById('stream-bg-art');

  const artUrl = ((track.album || {}).images || [])[0]?.url || null;

  if (nameEl)   nameEl.textContent   = track.name || '—';
  if (artistEl) artistEl.textContent = (track.artists || []).map(a => a.name).join(', ');
  if (totEl)    totEl.textContent    = fmtTime(track.duration_ms);
  if (bgEl && artUrl) bgEl.style.backgroundImage = `url(${artUrl})`;

  if (artWrap) {
    if (artUrl) {
      artWrap.innerHTML = `<img class="stream-art${stream.playing ? ' spinning' : ''}" src="${artUrl}" alt="" />`;
    } else {
      artWrap.innerHTML = `<div class="stream-art-ph"><svg width="72" height="72" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg></div>`;
    }
    artWrap.classList.toggle('playing', stream.playing);
  }
}

function updateStreamPlayPause(playing) {
  stream.playing = playing;
  const playIcon  = document.getElementById('stream-play-icon');
  const pauseIcon = document.getElementById('stream-pause-icon');
  if (playIcon)  playIcon.style.display  = playing ? 'none' : '';
  if (pauseIcon) pauseIcon.style.display = playing ? '' : 'none';
  // Toggle spinning on album art
  const artEl = document.querySelector('#stream-art-wrap .stream-art');
  if (artEl) artEl.classList.toggle('spinning', playing);
  const artWrap = document.getElementById('stream-art-wrap');
  if (artWrap) artWrap.classList.toggle('playing', playing);
}

function startStreamProgress() {
  if (stream.rafId) cancelAnimationFrame(stream.rafId);
  stream.rafId = requestAnimationFrame(tickStreamProgress);
}

function tickStreamProgress() {
  if (!stream.open) return;
  const pos = stream.playing
    ? Math.min(stream.rafBasePos + (Date.now() - stream.rafBaseTs), stream.durMs)
    : stream.posMs;
  const pct = stream.durMs > 0 ? Math.min((pos / stream.durMs) * 100, 100) : 0;
  const fill  = document.getElementById('stream-prog-fill');
  const thumb = document.getElementById('stream-prog-thumb');
  const cur   = document.getElementById('stream-cur');
  if (fill)  fill.style.width  = pct + '%';
  if (thumb) thumb.style.left  = `calc(${pct}% - 6px)`;
  if (cur)   cur.textContent   = fmtTime(pos);
  stream.rafId = requestAnimationFrame(tickStreamProgress);
}

function renderStreamTracklist() {
  const container = document.getElementById('stream-tracklist');
  if (!container) return;

  container.innerHTML = stream.tracks.map((track, idx) => {
    const isPlaying = track.spotifyUri === stream.currentUri;
    const isPlayed  = stream.playedUris.has(track.spotifyUri) && !isPlaying;
    const artHtml   = track.albumArt
      ? `<img class="stream-track-item-art" src="${track.albumArt}" alt="" loading="lazy" />`
      : `<div class="stream-track-item-art-ph"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;
    const stateHtml = isPlaying
      ? `<span class="eq-bars"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>`
      : isPlayed ? '✓' : `<span style="opacity:.3">${idx + 1}</span>`;

    return `<div class="stream-track-item${isPlaying ? ' is-playing' : ''}${isPlayed ? ' is-played' : ''}" data-uri="${escHtml(track.spotifyUri)}" data-idx="${idx}">
      ${artHtml}
      <div class="stream-track-item-info">
        <div class="stream-track-item-name">${escHtml(track.name)}</div>
        <div class="stream-track-item-artist">${escHtml(track.artist)}</div>
      </div>
      <div class="stream-track-state">${stateHtml}</div>
    </div>`;
  }).join('');

  // Click to jump to track
  container.querySelectorAll('.stream-track-item').forEach(item => {
    item.addEventListener('click', async () => {
      if (!sdkDeviceId) return;
      const fromIdx = parseInt(item.dataset.idx);
      const uris    = stream.tracks.slice(fromIdx).map(t => t.spotifyUri);
      // Mark all before this track as played
      stream.tracks.slice(0, fromIdx).forEach(t => stream.playedUris.add(t.spotifyUri));
      await api.playUris(uris, sdkDeviceId);
    });
  });
}

// ── Music Modal ──
let modalPlaylistId = null;
let modalSearchTimeout = null;

function openMusicModal(plId) {
  modalPlaylistId = plId;
  const pl = state.playlists.find(p => p.id === plId);
  if (!pl) return;

  const slotLabel = pl.slot === '09:30' ? '9h30' : '13h00';
  document.getElementById('modal-title').textContent = 'Quản lý nhạc';
  document.getElementById('modal-subtitle').textContent = `${slotLabel} – ${formatDateVN(pl.date)}`;
  document.getElementById('modal-search-inp').value = '';
  document.getElementById('modal-results').innerHTML = '';

  renderModalTracks(pl);
  document.getElementById('music-modal').classList.remove('hidden');
  document.getElementById('modal-search-inp').focus();
}

function closeMusicModal() {
  modalPlaylistId = null;
  document.getElementById('music-modal').classList.add('hidden');
  document.getElementById('modal-search-inp').value = '';
  document.getElementById('modal-results').innerHTML = '';
  // Reset bulk panel
  document.getElementById('modal-bulk-wrap')?.classList.add('hidden');
  document.getElementById('modal-bulk-toggle-btn')?.classList.remove('active');
  document.getElementById('modal-bulk-inp') && (document.getElementById('modal-bulk-inp').value = '');
  document.getElementById('modal-bulk-hint') && (document.getElementById('modal-bulk-hint').textContent = '');
}

function renderModalTracks(pl) {
  const list = document.getElementById('modal-track-list');
  const emptyMsg = document.getElementById('modal-empty-msg');
  const countChip = document.getElementById('modal-count-chip');
  const tracks = pl.tracks || [];
  const count = tracks.length;

  const max = state.maxTracks;
  countChip.textContent = `${count}/${max}`;
  countChip.className = `modal-count-chip${count >= max ? ' full' : ''}`;

  list.innerHTML = '';
  if (!count) {
    emptyMsg.style.display = '';
    return;
  }
  emptyMsg.style.display = 'none';

  tracks.forEach((track, idx) => {
    const row = document.createElement('div');
    row.className = 'modal-track-row';
    row.setAttribute('draggable', 'true');
    row.dataset.idx = idx;
    const artHtml = track.albumArt
      ? `<img class="modal-track-art" src="${track.albumArt}" alt="" />`
      : `<div class="modal-track-art-ph"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;
    row.innerHTML = `
      <span class="modal-drag-handle" title="Kéo để sắp xếp">⠿</span>
      <span class="modal-track-num">${idx + 1}</span>
      ${artHtml}
      <div class="modal-track-info">
        <div class="modal-track-name">${escHtml(track.name)}</div>
        <div class="modal-track-artist">${escHtml(track.artist)}</div>
      </div>
      <button class="icon-btn danger remove-modal-track" data-idx="${idx}" title="Xóa bài này" style="flex-shrink:0">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
        </svg>
      </button>`;
    row.querySelector('.remove-modal-track').addEventListener('click', e => { handleModalRemoveTrack(parseInt(e.currentTarget.closest('.modal-track-row').dataset.idx)); });
    list.appendChild(row);
  });

  // Setup drag-drop on modal list
  setupModalDragDrop(list, pl);
}

function setupModalDragDrop(list, pl) {
  let dragSrcIdx = null;
  let dragOverIdx = null;
  let rafId = null;

  list.addEventListener('dragstart', e => {
    const row = e.target.closest('.modal-track-row');
    if (!row) return;
    dragSrcIdx = parseInt(row.dataset.idx);
    row.classList.add('modal-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  list.addEventListener('dragend', e => {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const row = e.target.closest('.modal-track-row');
    if (row) row.classList.remove('modal-dragging');
    list.querySelectorAll('.modal-drag-over').forEach(r => r.classList.remove('modal-drag-over'));
    dragSrcIdx = null; dragOverIdx = null;
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.modal-track-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx);
    if (idx === dragOverIdx) return;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      list.querySelectorAll('.modal-drag-over').forEach(r => r.classList.remove('modal-drag-over'));
      if (idx !== dragSrcIdx) row.classList.add('modal-drag-over');
      dragOverIdx = idx;
      rafId = null;
    });
  });

  list.addEventListener('drop', e => {
    e.preventDefault();
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const row = e.target.closest('.modal-track-row');
    if (!row || dragSrcIdx === null) return;
    const dropIdx = parseInt(row.dataset.idx);
    if (dropIdx === dragSrcIdx) return;
    const src = dragSrcIdx, dst = dropIdx;
    dragSrcIdx = null; dragOverIdx = null;

    const tracks = [...(pl.tracks || [])];
    const [removed] = tracks.splice(src, 1);
    tracks.splice(dst, 0, removed);
    pl.tracks = tracks;
    savePlaylist(pl);

    const allRows = [...list.querySelectorAll('.modal-track-row')];
    const srcEl = allRows[src];
    const destEl = allRows[dst];
    if (src < dst) { list.insertBefore(srcEl, destEl.nextSibling); }
    else           { list.insertBefore(srcEl, destEl); }
    [...list.querySelectorAll('.modal-track-row')].forEach((r, i) => {
      r.dataset.idx = i;
      const n = r.querySelector('.modal-track-num');
      if (n) n.textContent = i + 1;
    });

    requestAnimationFrame(() => rerenderCard(pl));
  });
}

async function handleModalRemoveTrack(idx) {
  const pl = state.playlists.find(p => p.id === modalPlaylistId);
  if (!pl) return;
  pl.tracks = (pl.tracks || []).filter((_, i) => i !== idx);
  await savePlaylist(pl);
  renderModalTracks(pl);
  rerenderCard(pl);
}

async function handleModalAddTrack(track) {
  const pl = state.playlists.find(p => p.id === modalPlaylistId);
  if (!pl) return;
  if ((pl.tracks || []).length >= state.maxTracks) {
    alert(`Đã đạt tối đa ${state.maxTracks} bài cho playlist này.`);
    return;
  }
  pl.tracks = [...(pl.tracks || []), track];
  await savePlaylist(pl);
  renderModalTracks(pl);
  rerenderCard(pl);
  renderModalResults([]); // clear results after adding
  document.getElementById('modal-search-inp').value = '';
}

function renderModalResults(results, msg) {
  const container = document.getElementById('modal-results');
  container.innerHTML = '';
  if (msg) {
    container.innerHTML = `<div class="drop-msg">${escHtml(msg)}</div>`;
    return;
  }
  const pl = state.playlists.find(p => p.id === modalPlaylistId);
  const currentCount = pl ? (pl.tracks || []).length : 0;

  results.forEach(track => {
    const item = document.createElement('div');
    item.className = 'drop-item';
    const artHtml = track.albumArt
      ? `<img class="drop-art" src="${track.albumArt}" alt="" />`
      : `<div class="drop-art-ph"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg></div>`;
    const isFull = currentCount >= state.maxTracks;
    item.innerHTML = `
      ${artHtml}
      <div class="drop-info">
        <div class="drop-name">${escHtml(track.name)}</div>
        <div class="drop-artist">${escHtml(track.artist)}</div>
      </div>
      <button class="drop-add-btn" ${isFull ? 'disabled' : ''}>+ Thêm</button>`;
    item.querySelector('.drop-add-btn').addEventListener('click', () => handleModalAddTrack(track));
    container.appendChild(item);
  });
}

async function doModalSearch() {
  const q = document.getElementById('modal-search-inp').value.trim();
  if (!q) return;

  const searchBtn = document.getElementById('modal-search-btn');
  searchBtn.disabled = true;
  searchBtn.textContent = '...';

  if (isSpotifyTrackUrl(q)) {
    renderModalResults([], 'Đang lấy thông tin...');
    const res = await api.resolve(q);
    if (res.error) {
      renderModalResults([], '⚠ ' + res.error);
    } else {
      await handleModalAddTrack(res.track);
    }
  } else {
    renderModalResults([], 'Đang tìm kiếm...');
    const res = await api.search(q);
    if (res.error) {
      renderModalResults([], '⚠ ' + res.error);
    } else if (!res.results || !res.results.length) {
      renderModalResults([], 'Không tìm thấy kết quả.');
    } else {
      renderModalResults(res.results);
    }
  }

  searchBtn.disabled = false;
  searchBtn.textContent = 'Tìm';
}

// ── Credentials & Settings ──
async function saveCredentials() {
  const maxTracks = parseInt(document.getElementById('inp-max-tracks').value) || 5;
  state.maxTracks = Math.max(1, Math.min(10, maxTracks));
  if (api) await api.setCredentials({ maxTracks: state.maxTracks });
  renderAll(); // re-render cards with updated count
  document.getElementById('settings-dialog').classList.add('hidden');
}

// ── Bootstrap ──
async function bootstrap() {
  document.getElementById('inp-date').value = todayISO();

  if (api) {
    const cfg = await api.getConfig();
    state.playlists = cfg.playlists || [];
    state.loggedIn = cfg.loggedIn || false;
    state.maxTracks = cfg.maxTracks || 5;
    document.getElementById('inp-max-tracks').value = state.maxTracks;

    updateLoginUI(state.loggedIn, cfg.profile);

    // Subscribe to push updates
    api.onUpdate((playlists, meta) => {
      state.playlists = Array.isArray(playlists) ? playlists : [];
      if (meta) updateLoginUI(meta.loggedIn, meta.profile);
      renderAll();
    });

    api.onScheduledPlay((playlistId) => {
      handlePlay(playlistId);
    });
  }

  renderAll();

  // ── Settings dialog ──
  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('settings-dialog').classList.remove('hidden');
  });
  document.getElementById('settings-dlg-close').addEventListener('click', () => {
    document.getElementById('settings-dialog').classList.add('hidden');
  });
  document.getElementById('settings-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // ── About dialog ──
  document.getElementById('about-btn').addEventListener('click', () => {
    document.getElementById('about-dialog').classList.remove('hidden');
  });
  document.getElementById('about-dlg-close').addEventListener('click', () => {
    document.getElementById('about-dialog').classList.add('hidden');
  });
  document.getElementById('about-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // ── Guide dialog ──
  document.getElementById('guide-btn').addEventListener('click', () => {
    document.getElementById('guide-dialog').classList.remove('hidden');
  });
  document.getElementById('guide-dlg-close').addEventListener('click', () => {
    document.getElementById('guide-dialog').classList.add('hidden');
  });
  document.getElementById('guide-dialog').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // ESC closes any open dialog
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      ['settings-dialog','about-dialog','guide-dialog'].forEach(id =>
        document.getElementById(id).classList.add('hidden')
      );
    }
  });

  document.getElementById('save-creds-btn').addEventListener('click', saveCredentials);

  // ── Login button ──
  document.getElementById('login-btn').addEventListener('click', async () => {
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Đang mở trình duyệt...';
    const res = await api.login();
    if (res && res.error) {
      alert('Đăng nhập thất bại: ' + res.error);
    } else if (res && res.success) {
      const profRes = await api.getProfile().catch(() => ({}));
      updateLoginUI(true, profRes.profile || null);
    }
    btn.disabled = false;
    btn.textContent = 'Đăng nhập Spotify';
  });

  // ── User menu dropdown ──
  const userBtn      = document.getElementById('user-btn');
  const userDropdown = document.getElementById('user-dropdown');

  userBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = userDropdown.classList.toggle('open');
    userBtn.classList.toggle('open', open);
  });

  document.addEventListener('click', () => {
    userDropdown.classList.remove('open');
    userBtn.classList.remove('open');
  });

  document.getElementById('view-profile-btn').addEventListener('click', async () => {
    const profile = state.profile;
    const url = profile && profile.profileUrl
      ? profile.profileUrl
      : 'https://open.spotify.com';
    await api.openUrl(url);
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api.logout();
    updateLoginUI(false, null);
    renderAll();
  });

  // ── Player bar controls ──
  document.getElementById('pb-playpause').addEventListener('click', async () => {
    const icon = document.getElementById('pb-play-icon');
    const isCurrentlyPaused = icon.style.display !== 'none'; // play icon visible = paused
    await api.playbackControl(isCurrentlyPaused ? 'resume' : 'pause');
    setTimeout(pollPlayerState, 500);
  });

  document.getElementById('pb-prev').addEventListener('click', async () => {
    await api.playbackControl('prev');
    setTimeout(pollPlayerState, 800);
  });

  document.getElementById('pb-next').addEventListener('click', async () => {
    await api.playbackControl('next');
    setTimeout(pollPlayerState, 800);
  });

  document.getElementById('pb-stop').addEventListener('click', async () => {
    await api.playbackControl('pause');
    state.activePlaylistId = null;
    setTimeout(pollPlayerState, 500);
  });

  document.getElementById('pb-open-spotify').addEventListener('click', () => {
    api.openSpotify();
  });

  // Progress bar click → seek
  const barWrap = document.getElementById('pb-bar-wrap');
  if (barWrap) {
    barWrap.addEventListener('click', async (e) => {
      const rect = barWrap.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      // Get current duration from last poll state
      const res = await api.playerState().catch(() => ({}));
      if (res && res.state && res.state.item) {
        const duration = res.state.item.duration_ms;
        await api.playbackControl('seek', Math.round(pct * duration));
        setTimeout(pollPlayerState, 300);
      }
    });
  }

  // Volume slider → Spotify volume
  const volSlider = document.getElementById('pb-volume');
  if (volSlider) {
    let volTimer = null;
    volSlider.addEventListener('input', () => {
      clearTimeout(volTimer);
      volTimer = setTimeout(() => {
        api.playbackControl('volume', parseInt(volSlider.value));
      }, 300);
    });
  }

  // ── Music Modal ──
  document.getElementById('modal-close').addEventListener('click', closeMusicModal);
  document.getElementById('music-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('music-modal')) closeMusicModal();
  });

  document.getElementById('modal-search-btn').addEventListener('click', doModalSearch);
  document.getElementById('modal-search-inp').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doModalSearch();
  });

  // ── Bulk paste toggle ──
  const bulkToggleBtn = document.getElementById('modal-bulk-toggle-btn');
  const bulkWrap = document.getElementById('modal-bulk-wrap');
  bulkToggleBtn?.addEventListener('click', () => {
    const isOpen = !bulkWrap.classList.contains('hidden');
    bulkWrap.classList.toggle('hidden', isOpen);
    bulkToggleBtn.classList.toggle('active', !isOpen);
    if (!isOpen) document.getElementById('modal-bulk-inp')?.focus();
  });

  document.getElementById('modal-bulk-add-btn')?.addEventListener('click', async () => {
    const pl = state.playlists.find(p => p.id === modalPlaylistId);
    if (!pl) return;
    const raw = document.getElementById('modal-bulk-inp').value;
    const hint = document.getElementById('modal-bulk-hint');
    const links = raw.split('\n').map(l => l.trim()).filter(l => isSpotifyTrackUrl(l));
    const available = state.maxTracks - (pl.tracks || []).length;
    if (!links.length) { hint.textContent = 'Không tìm thấy link hợp lệ.'; hint.className = 'modal-bulk-hint err'; return; }
    if (available <= 0) { hint.textContent = `Số lượng nhạc vượt quá mức cho phép (${state.maxTracks} bài).`; hint.className = 'modal-bulk-hint err'; return; }
    const toAdd = links.slice(0, available);
    const skipped = links.length - toAdd.length;
    hint.textContent = 'Đang thêm...'; hint.className = 'modal-bulk-hint';
    document.getElementById('modal-bulk-add-btn').disabled = true;
    let added = 0;
    for (const link of toAdd) {
      const res = await api.resolve(link);
      if (!res.error && res.track) { pl.tracks = [...(pl.tracks || []), res.track]; added++; }
    }
    await savePlaylist(pl);
    renderModalTracks(pl);
    rerenderCard(pl);
    document.getElementById('modal-bulk-inp').value = '';
    document.getElementById('modal-bulk-add-btn').disabled = false;
    const overMsg = links.length > available ? ` Số lượng nhạc vượt quá mức cho phép (${state.maxTracks} bài), đã bỏ qua ${skipped}.` : '';
    hint.textContent = `Đã thêm ${added} bài.${overMsg}`;
    hint.className = links.length > available ? 'modal-bulk-hint warn' : 'modal-bulk-hint';
  });

  // ── Stream modal event listeners ──
  document.getElementById('stream-close-btn')?.addEventListener('click', () => closeStreamModal());
  document.getElementById('stream-playpause')?.addEventListener('click', () => {
    if (sdkPlayer) sdkPlayer.togglePlay().catch(() => {});
  });
  document.getElementById('stream-prev')?.addEventListener('click', () => {
    if (sdkPlayer) sdkPlayer.previousTrack().catch(() => {});
  });
  document.getElementById('stream-next')?.addEventListener('click', () => {
    if (sdkPlayer) sdkPlayer.nextTrack().catch(() => {});
  });
  document.getElementById('stream-prog-bar')?.addEventListener('click', (e) => {
    if (!sdkPlayer || !stream.durMs) return;
    const rect  = e.currentTarget.getBoundingClientRect();
    const pct   = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    const posMs = Math.round(pct * stream.durMs);
    sdkPlayer.seek(posMs).catch(() => {});
    stream.posMs = posMs; stream.rafBasePos = posMs; stream.rafBaseTs = Date.now();
  });
  // Close on overlay click (outside stream-box)
  document.getElementById('stream-modal')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('stream-modal')) closeStreamModal();
  });

  // ── Filter buttons ──
  // Default: show all playlists (state already initialized with type:'all', date:null)
  document.getElementById('filter-all')?.addEventListener('click', () => setFilter('all'));
  ['today'].forEach(type => {
    const btn = document.getElementById('filter-' + type);
    if (btn) btn.addEventListener('click', () => setFilter(type));
  });

  // Slot select — combinable with date filter
  const slotSelect = document.getElementById('filter-slot-select');
  if (slotSelect) {
    slotSelect.addEventListener('change', () => {
      state.filter.slot = slotSelect.value || null;
      renderAll();
    });
  }

  // View select
  document.getElementById('view-select')?.addEventListener('change', (e) => {
    state.view = e.target.value;
    renderAll();
  });

  // Custom date button: click opens native date picker
  const customBtn = document.getElementById('filter-custom-btn');
  const dateInpEl = document.getElementById('filter-date-inp');
  if (customBtn && dateInpEl) {
    dateInpEl.value = todayISO();
    customBtn.addEventListener('click', () => { try { dateInpEl.showPicker(); } catch(e) { dateInpEl.click(); } });
    dateInpEl.addEventListener('change', () => {
      if (dateInpEl.value) {
        setFilter('custom', dateInpEl.value);
        const label = document.getElementById('filter-custom-label');
        if (label) label.textContent = formatDateVNShort(dateInpEl.value);
        customBtn.classList.add('active');
      }
    });
  }

  // ── Theme toggle ──
  function applyTheme(theme) {
    document.documentElement.classList.remove('theme-dark', 'theme-light', 'theme-system');
    document.documentElement.classList.add('theme-' + theme);
    ['dark','light','system'].forEach(t => {
      document.getElementById('theme-' + t)?.classList.toggle('active', t === theme);
    });
    try { localStorage.setItem('app-theme', theme); } catch(e) {}
  }
  const savedTheme = localStorage.getItem('app-theme') || 'dark';
  applyTheme(savedTheme);
  ['dark','light','system'].forEach(t => {
    document.getElementById('theme-' + t)?.addEventListener('click', () => applyTheme(t));
  });

  // ── Create playlist ──
  document.getElementById('create-btn').addEventListener('click', async () => {
    const date = document.getElementById('inp-date').value;
    const slot = document.getElementById('inp-slot').value;
    if (!date) { alert('Chọn ngày trước.'); return; }
    const exists = state.playlists.find(p => p.date === date && p.slot === slot);
    if (exists) { alert('Playlist cho khung giờ này đã tồn tại.'); return; }
    const pl = { id: uid(), date, slot, tracks: [], status: 'pending', createdAt: new Date().toISOString() };
    state.playlists.push(pl);
    await savePlaylist(pl);
    renderAll();
  });
}

window.addEventListener('DOMContentLoaded', () => bootstrap().catch(console.error));

