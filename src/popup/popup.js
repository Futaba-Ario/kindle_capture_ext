function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

const manualPagesInput = document.getElementById('input-pages');
const manualPagesLabel = document.getElementById('manual-pages-label');
const captureModeInputs = Array.from(document.querySelectorAll('input[name="capture-mode"]'));

function getSelectedCaptureMode() {
  const selected = captureModeInputs.find((input) => input.checked);
  return selected ? selected.value : 'auto';
}

function syncCaptureModeUi() {
  const isManualMode = getSelectedCaptureMode() === 'manual';
  manualPagesInput.disabled = !isManualMode;
  manualPagesLabel.classList.toggle('field-disabled', !isManualMode);
}

captureModeInputs.forEach((input) => {
  input.addEventListener('change', syncCaptureModeUi);
});

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
  const mode = getSelectedCaptureMode();
  const manualPages = parseInt(manualPagesInput.value, 10);
  const waitMs = parseInt(document.getElementById('input-wait').value, 10) || 1500;
  const splitLimit = parseInt(document.getElementById('input-split').value, 10) || 0;

  if (mode === 'manual' && (!Number.isInteger(manualPages) || manualPages <= 0)) {
    setStatus('Error: Manual mode requires a page count of 1 or more.');
    return;
  }

  const startLabel = mode === 'auto'
    ? `Starting capture (Auto, Wait: ${waitMs}ms, Split: ${splitLimit})...`
    : `Starting capture (Manual: ${manualPages} pages, Wait: ${waitMs}ms, Split: ${splitLimit})...`;
  setStatus(startLabel);

  chrome.runtime.sendMessage({
    action: 'START_LOOP',
    mode,
    manualPages: mode === 'manual' ? manualPages : undefined,
    waitMs,
    splitLimit
  }, (response) => {
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

syncCaptureModeUi();
