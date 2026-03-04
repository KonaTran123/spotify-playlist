'use strict';

const { ipcRenderer } = require('electron');

let finishedTimer = null;

function clearFinishedTimer() {
  if (finishedTimer) {
    clearTimeout(finishedTimer);
    finishedTimer = null;
  }
}

function scheduleFinishedNotification() {
  clearFinishedTimer();
  // Nếu sau ~20s không có bài mới phát lại, coi như playlist đã kết thúc.
  finishedTimer = setTimeout(() => {
    ipcRenderer.send('playlist:finished');
  }, 20000);
}

function attachMediaListeners(media) {
  if (!media || media.__ytmAutoHooked) return;
  media.__ytmAutoHooked = true;

  media.addEventListener('playing', () => {
    clearFinishedTimer();
  });

  media.addEventListener('ended', () => {
    scheduleFinishedNotification();
  });

  // Cố gắng auto-play nếu có thể (có thể bị chặn bởi policy của trình duyệt).
  try {
    const playResult = media.play();
    if (playResult && typeof playResult.catch === 'function') {
      playResult.catch(() => {
        // bị chặn autoplay, người dùng sẽ phải bấm play thủ công.
      });
    }
  } catch (_) {
    // ignore
  }
}

function scanForMedia() {
  const media = document.querySelector('video, audio');
  if (media) {
    attachMediaListeners(media);
  }
}

function bootstrap() {
  scanForMedia();
  const observer = new MutationObserver(scanForMedia);
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}

window.addEventListener('DOMContentLoaded', bootstrap);
