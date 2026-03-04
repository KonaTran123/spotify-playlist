'use strict';

const api = window.ytmAutoPlayer;

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function extractYoutubeId(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return v;
    const match = u.pathname.match(/\/([a-zA-Z0-9_-]{6,})$/);
    if (match) return match[1];
  } catch (_) {
    return null;
  }
  return null;
}

function getThumbnail(url) {
  const id = extractYoutubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

function createCard({ id, date, slot, urls, status, playedAt }) {
  return {
    id: id || `${date}-${slot}-${Date.now()}`,
    date,
    slot,
    urls: (urls || []).filter(Boolean).slice(0, 4),
    status: status || 'pending',
    playedAt: playedAt || null
  };
}

async function loadConfig() {
  if (!api || !api.getConfig) {
    return { cards: [] };
  }
  try {
    const cfg = await api.getConfig();
    return { cards: Array.isArray(cfg.cards) ? cfg.cards : [] };
  } catch (e) {
    console.error('Failed to load config from main:', e);
    return { cards: [] };
  }
}

async function saveConfig(cfg) {
  if (!api || !api.saveConfig) return;
  try {
    await api.saveConfig(cfg);
  } catch (e) {
    console.error('Failed to save config:', e);
  }
}

function renderCards(cards) {
  const root = document.getElementById('cards');
  root.innerHTML = '';

  if (!cards.length) {
    const empty = document.createElement('div');
    empty.className = 'placeholder';
    empty.textContent = 'Chưa có card nào. Hãy tạo card cho 9h30 hoặc 13h.';
    root.appendChild(empty);
    return;
  }

  cards
    .slice()
    .sort((a, b) => (a.date === b.date ? a.slot.localeCompare(b.slot) : a.date.localeCompare(b.date)))
    .forEach((card) => {
      const el = document.createElement('article');
      el.className = `playlist-card${card.status === 'played' ? ' playlist-card--played' : ''}`;

      const header = document.createElement('header');
      header.className = 'playlist-card__header';
      header.innerHTML = `
        <div>
          <div class="playlist-card__slot">${card.slot}</div>
          <div class="playlist-card__date">${card.date}</div>
        </div>
        <div class="playlist-card__status">${
          card.status === 'played' ? 'Đã phát' : 'Chưa phát'
        }</div>
      `;

      const list = document.createElement('ul');
      list.className = 'playlist-card__tracks';

      (card.urls || []).forEach((url, index) => {
        const li = document.createElement('li');
        li.className = 'playlist-card__track';
        const thumb = getThumbnail(url);
        li.innerHTML = `
          <div class="track-thumb${thumb ? '' : ' track-thumb--empty'}"${
            thumb ? ` style="background-image:url('${thumb}')"` : ''
          }></div>
          <div class="track-meta">
            <div class="track-title">Bài ${index + 1}</div>
            <div class="track-url" title="${url}">${url}</div>
          </div>
        `;
        list.appendChild(li);
      });

      el.appendChild(header);
      el.appendChild(list);

      root.appendChild(el);
    });
}

async function bootstrap() {
  const form = document.getElementById('card-form');
  const dateInput = document.getElementById('date');
  const slotInput = document.getElementById('slot');
  const urlInputs = Array.from(document.querySelectorAll('.url-input'));

  dateInput.value = todayISO();

  let state = await loadConfig();
  state.cards = Array.isArray(state.cards) ? state.cards : [];
  renderCards(state.cards);

  if (api && typeof api.onCardsUpdated === 'function') {
    api.onCardsUpdated((cards) => {
      state.cards = Array.isArray(cards) ? cards : [];
      renderCards(state.cards);
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const date = dateInput.value;
    const slot = slotInput.value;
    const urls = urlInputs.map((i) => i.value.trim()).filter(Boolean);

    if (!date || !slot || !urls.length) {
      alert('Vui lòng chọn ngày, khung giờ và nhập ít nhất 1 URL.');
      return;
    }

    const card = createCard({ date, slot, urls });
    state.cards.push(card);
    renderCards(state.cards);
    await saveConfig(state);

    urlInputs.forEach((i) => (i.value = ''));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  bootstrap().catch((e) => console.error(e));
});
