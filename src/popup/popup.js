function setStatus(msg) {
  document.getElementById('status').textContent = msg;
}

function setMetrics(metrics) {
  const lines = [
    `Stage: ${metrics.stage || 'idle'}`,
    `Page: ${metrics.page || 0}/${metrics.total || 0}`,
    `Wait: ${metrics.waitMs || 0}ms`,
    `Format: ${metrics.format || 'jpeg'}`,
    `JPEG quality: ${metrics.jpegQuality || 0}`,
    `Max long edge: ${metrics.maxLongEdge || 0}px`,
    `Estimated: ${toMb(metrics.estimatedBytes || 0)}MB`,
    `Fallback step: ${metrics.fallbackStep || 0}`
  ];
  document.getElementById('metrics').textContent = lines.join('\n');
}

function toMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function readInt(id, fallback) {
  const parsed = Number.parseInt(document.getElementById(id).value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return parsed;
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
  const pages = readInt('input-pages', 10);
  const waitMs = readInt('input-wait', 1500);
  const splitLimit = readInt('input-split', 0);
  const captureFormat = document.getElementById('input-format').value === 'png' ? 'png' : 'jpeg';
  const jpegQuality = readInt('input-jpeg-quality', 82);
  const maxLongEdge = readInt('input-max-long-edge', 2200);
  const checkpointPages = readInt('input-checkpoint-pages', 20);
  const adaptiveDelay = document.getElementById('input-adaptive-delay').value !== 'false';
  const minWaitMs = readInt('input-min-wait', 900);
  const maxWaitMs = readInt('input-max-wait', 3500);

  setStatus(`Starting loop: pages=${pages}, wait=${waitMs}ms, split=${splitLimit}, format=${captureFormat}`);

  chrome.runtime.sendMessage({
    action: 'START_LOOP',
    pages,
    waitMs,
    splitLimit,
    captureFormat,
    jpegQuality,
    maxLongEdge,
    checkpointPages,
    adaptiveDelay,
    minWaitMs,
    maxWaitMs
  }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
      } else {
        setStatus(response && response.status ? response.status : 'Loop started');
      }
      setMetrics({
        stage: 'running',
        page: 0,
        total: pages,
        waitMs,
        format: captureFormat,
        jpegQuality,
        maxLongEdge,
        estimatedBytes: 0,
        fallbackStep: 0
      });
    }
  );
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
  if (msg.action === 'UPDATE_METRICS' && msg.metrics) {
    setMetrics(msg.metrics);
  }
});
