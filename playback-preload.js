'use strict';

const { ipcRenderer } = require('electron');

function attachEndedListener() {
  const hook = () => {
    const media = document.querySelector('video, audio');
    if (media && !media.__ytmAutoHooked) {
      media.__ytmAutoHooked = true;
      media.addEventListener('ended', () => {
        ipcRenderer.send('playback:ended');
      });
    }
  };

  hook();
  const observer = new MutationObserver(hook);
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}

window.addEventListener('DOMContentLoaded', attachEndedListener);
