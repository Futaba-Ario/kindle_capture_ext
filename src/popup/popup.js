function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

document.getElementById('btn-capture-one').addEventListener('click', () => {
  setStatus('Requesting capture...');
  chrome.runtime.sendMessage({ action: 'CAPTURE_ONE' }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message);
    } else {
      setStatus(response && response.status ? response.status : 'Command sent');
    }
  });
});

document.getElementById('btn-turn-page').addEventListener('click', () => {
  setStatus('Requesting page turn...');
  chrome.runtime.sendMessage({ action: 'TURN_PAGE' }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message);
    } else {
      setStatus(response && response.status ? response.status : 'Turn command sent');
    }
  });
});

document.getElementById('btn-start-loop').addEventListener('click', () => {
  const pages = parseInt(document.getElementById('input-pages').value, 10) || 10;
  const waitMs = parseInt(document.getElementById('input-wait').value, 10) || 1500;
  setStatus(`Starting loop for ${pages} pages (Wait: ${waitMs}ms)...`);

  chrome.runtime.sendMessage({ action: 'START_LOOP', pages: pages, waitMs: waitMs }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus('Error: ' + chrome.runtime.lastError.message);
    } else {
      setStatus(response && response.status ? response.status : 'Loop started');
    }
  });
});

document.getElementById('btn-stop').addEventListener('click', () => {
  setStatus('Stopping...');
  chrome.runtime.sendMessage({ action: 'STOP_LOOP' }, (response) => {
    setStatus(response && response.status ? response.status : 'Stop requested');
  });
});

// Listener for status updates from SW
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'UPDATE_STATUS') {
    setStatus(msg.status);
  }
});
