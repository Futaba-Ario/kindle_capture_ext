const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const STATE = {
    status: 'idle', // idle | running | finalizing | done | error
    stopRequested: false,
    currentWaitMs: 1500,
    totalPages: 0,
    capturedPages: 0,
    partIndex: 1,
    pagesInPart: 0,
    pagesSinceCheckpoint: 0,
    fallbackStep: 0,
    settings: null
};

const DEFAULTS = {
    pages: 10,
    waitMs: 1500,
    splitLimit: 0,
    captureFormat: 'jpeg',
    jpegQuality: 82,
    maxLongEdge: 2200,
    checkpointPages: 20,
    adaptiveDelay: true,
    minWaitMs: 900,
    maxWaitMs: 3500
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CAPTURE_ONE') {
        handleCaptureOne(sendResponse);
        return true;
    }
    if (request.action === 'TURN_PAGE') {
        handlePageTurn(sendResponse);
        return true;
    }
    if (request.action === 'START_LOOP') {
        if (STATE.status === 'running' || STATE.status === 'finalizing') {
            sendResponse({ status: 'Already capturing' });
            return false;
        }
        const settings = normalizeStartRequest(request);
        void startCaptureLoop(settings);
        sendResponse({ status: 'Loop started' });
        return false;
    }
    if (request.action === 'STOP_LOOP') {
        if (STATE.status === 'running' || STATE.status === 'finalizing') {
            STATE.stopRequested = true;
            sendResponse({ status: 'Stop flag set' });
        } else {
            sendResponse({ status: 'Not running' });
        }
        return false;
    }
    if (request.action === 'JOB_STATUS') {
        notifyPopup(buildStatusLine(request));
        notifyMetrics({
            stage: request.stage || STATE.status,
            page: STATE.capturedPages,
            total: STATE.totalPages,
            waitMs: STATE.currentWaitMs,
            format: STATE.settings ? STATE.settings.captureFormat : DEFAULTS.captureFormat,
            jpegQuality: STATE.settings ? STATE.settings.jpegQuality : DEFAULTS.jpegQuality,
            maxLongEdge: STATE.settings ? STATE.settings.maxLongEdge : DEFAULTS.maxLongEdge,
            estimatedBytes: request.estimatedBytes || 0,
            fallbackStep: STATE.fallbackStep
        });
        return false;
    }
    if (request.action === 'JOB_ERROR') {
        const level = request.recoverable ? 'Recoverable' : 'Fatal';
        notifyPopup(`${level} offscreen error: ${request.error}`);
        return false;
    }
    return false;
});

async function handlePageTurn(sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            sendResponse({ status: 'No active tab' });
            return;
        }
        await sendPageTurn(tab.id);
        sendResponse({ status: 'Turned' });
    } catch (e) {
        sendResponse({ status: 'Error: ' + e.message });
    }
}

async function handleCaptureOne(sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) {
            sendResponse({ status: 'No active tab' });
            return;
        }
        await captureAndDownload(tab.windowId, 1);
        sendResponse({ status: 'Captured' });
    } catch (e) {
        sendResponse({ status: 'Error: ' + e.message });
    }
}

function normalizeStartRequest(request) {
    const pages = Math.max(1, parseInteger(request.pages, DEFAULTS.pages));
    const waitMs = Math.max(0, parseInteger(request.waitMs, DEFAULTS.waitMs));
    const splitLimit = Math.max(0, parseInteger(request.splitLimit, DEFAULTS.splitLimit));
    const captureFormat = request.captureFormat === 'png' ? 'png' : 'jpeg';
    const jpegQuality = clamp(parseInteger(request.jpegQuality, DEFAULTS.jpegQuality), 10, 100);
    const maxLongEdge = Math.max(800, parseInteger(request.maxLongEdge, DEFAULTS.maxLongEdge));
    const checkpointPages = Math.max(1, parseInteger(request.checkpointPages, DEFAULTS.checkpointPages));
    const adaptiveDelay = request.adaptiveDelay !== false;
    const minWaitMs = Math.max(0, parseInteger(request.minWaitMs, DEFAULTS.minWaitMs));
    const maxWaitMs = Math.max(minWaitMs, parseInteger(request.maxWaitMs, DEFAULTS.maxWaitMs));

    return {
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
    };
}

async function setupOffscreenDocument(path) {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(path)]
    });

    if (existingContexts.length > 0) {
        return;
    }
    if (!chrome.offscreen) {
        throw new Error('Offscreen API not available');
    }

    await chrome.offscreen.createDocument({
        url: path,
        reasons: ['BLOBS'],
        justification: 'To generate PDF from captured images'
    });
}

async function startCaptureLoop(settings) {
    STATE.status = 'running';
    STATE.stopRequested = false;
    STATE.currentWaitMs = settings.waitMs;
    STATE.totalPages = settings.pages;
    STATE.capturedPages = 0;
    STATE.partIndex = 1;
    STATE.pagesInPart = 0;
    STATE.pagesSinceCheckpoint = 0;
    STATE.fallbackStep = 0;
    STATE.settings = { ...settings };

    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            throw new Error('No active tab');
        }

        notifyPopup('Initializing offscreen PDF job...');
        notifyMetrics({
            stage: STATE.status,
            page: 0,
            total: STATE.totalPages,
            waitMs: STATE.currentWaitMs,
            format: STATE.settings.captureFormat,
            jpegQuality: STATE.settings.jpegQuality,
            maxLongEdge: STATE.settings.maxLongEdge,
            estimatedBytes: 0,
            fallbackStep: STATE.fallbackStep
        });

        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
        await sendRuntimeMessage({
            action: 'INIT_JOB',
            config: {
                captureFormat: STATE.settings.captureFormat,
                jpegQuality: STATE.settings.jpegQuality,
                maxLongEdge: STATE.settings.maxLongEdge,
                checkpointPages: STATE.settings.checkpointPages
            }
        });

        for (let i = 0; i < STATE.totalPages; i++) {
            if (STATE.stopRequested) {
                notifyPopup(`Stop requested at page ${i + 1}. Finalizing captured pages...`);
                break;
            }

            notifyPopup(`Capturing page ${i + 1}/${STATE.totalPages}...`);
            const dataUrl = await captureOneFrame(tab.windowId, STATE.settings);

            const addStart = Date.now();
            try {
                await sendRuntimeMessage({
                    action: 'ADD_PAGE',
                    seq: i + 1,
                    dataUrl,
                    captureFormat: STATE.settings.captureFormat
                });
            } catch (error) {
                const recovered = await handleRecovery(error);
                if (!recovered) {
                    throw error;
                }
                const retriedUrl = await captureOneFrame(tab.windowId, STATE.settings);
                await sendRuntimeMessage({
                    action: 'ADD_PAGE',
                    seq: i + 1,
                    dataUrl: retriedUrl,
                    captureFormat: STATE.settings.captureFormat
                });
            }
            const procMs = Date.now() - addStart;

            STATE.capturedPages += 1;
            STATE.pagesInPart += 1;
            STATE.pagesSinceCheckpoint += 1;

            if (STATE.settings.adaptiveDelay) {
                STATE.currentWaitMs = clamp(
                    Math.round(STATE.settings.waitMs + (procMs * 0.6)),
                    STATE.settings.minWaitMs,
                    STATE.settings.maxWaitMs
                );
            } else {
                STATE.currentWaitMs = STATE.settings.waitMs;
            }

            notifyMetrics({
                stage: STATE.status,
                page: STATE.capturedPages,
                total: STATE.totalPages,
                waitMs: STATE.currentWaitMs,
                format: STATE.settings.captureFormat,
                jpegQuality: STATE.settings.jpegQuality,
                maxLongEdge: STATE.settings.maxLongEdge,
                estimatedBytes: 0,
                fallbackStep: STATE.fallbackStep
            });

            if (STATE.pagesSinceCheckpoint >= STATE.settings.checkpointPages) {
                await sendRuntimeMessage({ action: 'CHECKPOINT_PDF' });
                STATE.pagesSinceCheckpoint = 0;
            }

            if (STATE.settings.splitLimit > 0 && STATE.pagesInPart >= STATE.settings.splitLimit) {
                await finalizePartAndDownload(true);
            }

            if (!STATE.stopRequested && i < STATE.totalPages - 1) {
                notifyPopup(`Turning page ${i + 1}...`);
                await sendPageTurn(tab.id);
                await sleep(STATE.currentWaitMs);
            }
        }

        if (STATE.pagesInPart > 0) {
            await finalizePartAndDownload(false);
        } else if (STATE.capturedPages === 0) {
            notifyPopup('No pages captured.');
        }

        if (STATE.stopRequested) {
            STATE.status = 'done';
            notifyPopup(`Stopped. Captured ${STATE.capturedPages} page(s).`);
        } else {
            STATE.status = 'done';
            notifyPopup(`Done. Captured ${STATE.capturedPages} page(s).`);
        }
    } catch (e) {
        console.error(e);
        STATE.status = 'error';
        notifyPopup('Error: ' + e.message);
        chrome.runtime.sendMessage({
            action: 'JOB_ERROR',
            recoverable: false,
            error: e.message
        }).catch(() => {});
    } finally {
        STATE.status = 'idle';
        STATE.stopRequested = false;
        notifyMetrics({
            stage: STATE.status,
            page: STATE.capturedPages,
            total: STATE.totalPages,
            waitMs: STATE.currentWaitMs,
            format: STATE.settings ? STATE.settings.captureFormat : DEFAULTS.captureFormat,
            jpegQuality: STATE.settings ? STATE.settings.jpegQuality : DEFAULTS.jpegQuality,
            maxLongEdge: STATE.settings ? STATE.settings.maxLongEdge : DEFAULTS.maxLongEdge,
            estimatedBytes: 0,
            fallbackStep: STATE.fallbackStep
        });
    }
}

async function finalizePartAndDownload(hasMoreParts) {
    STATE.status = 'finalizing';
    notifyPopup(`Finalizing ${STATE.settings.splitLimit > 0 ? `part ${STATE.partIndex}` : 'PDF'}...`);

    let finalized;
    try {
        finalized = await sendRuntimeMessage({
            action: 'FINALIZE_PDF',
            resetAfterFinalize: hasMoreParts || STATE.settings.splitLimit > 0
        });
    } catch (error) {
        const recovered = await handleRecovery(error);
        if (!recovered) {
            throw error;
        }
        finalized = await sendRuntimeMessage({
            action: 'FINALIZE_PDF',
            resetAfterFinalize: hasMoreParts || STATE.settings.splitLimit > 0
        });
    }

    if (!finalized || !finalized.dataUrl) {
        throw new Error('Finalize response did not include a PDF payload');
    }

    if (STATE.settings.splitLimit === 0 && finalized.estimatedBytes > 180 * 1024 * 1024) {
        notifyPopup('Warning: PDF is very large. Consider enabling split pages for more stability.');
    }

    const filename = buildFilename(STATE.settings.splitLimit > 0 ? STATE.partIndex : null);
    await downloadPdf(finalized.dataUrl, filename);

    STATE.partIndex += 1;
    STATE.pagesInPart = 0;
    STATE.pagesSinceCheckpoint = 0;
    STATE.status = 'running';
}

async function handleRecovery(error) {
    const message = error instanceof Error ? error.message : String(error);

    if (STATE.fallbackStep === 0) {
        if (STATE.settings.captureFormat === 'jpeg') {
            STATE.settings.jpegQuality = clamp(STATE.settings.jpegQuality - 10, 35, 100);
            STATE.fallbackStep += 1;
            notifyPopup(`Recovering: lowering JPEG quality to ${STATE.settings.jpegQuality}.`);
            await sendRuntimeMessage({
                action: 'UPDATE_JOB_CONFIG',
                config: {
                    captureFormat: STATE.settings.captureFormat,
                    jpegQuality: STATE.settings.jpegQuality,
                    maxLongEdge: STATE.settings.maxLongEdge
                }
            });
            return true;
        }
        STATE.settings.captureFormat = 'jpeg';
        STATE.settings.jpegQuality = 82;
        STATE.fallbackStep += 1;
        notifyPopup('Recovering: switching capture format to JPEG.');
        await sendRuntimeMessage({
            action: 'UPDATE_JOB_CONFIG',
            config: {
                captureFormat: STATE.settings.captureFormat,
                jpegQuality: STATE.settings.jpegQuality,
                maxLongEdge: STATE.settings.maxLongEdge
            }
        });
        return true;
    }

    if (STATE.fallbackStep === 1) {
        STATE.settings.maxLongEdge = Math.max(1200, STATE.settings.maxLongEdge - 300);
        STATE.fallbackStep += 1;
        notifyPopup(`Recovering: lowering max long edge to ${STATE.settings.maxLongEdge}px.`);
        await sendRuntimeMessage({
            action: 'UPDATE_JOB_CONFIG',
            config: {
                captureFormat: STATE.settings.captureFormat,
                jpegQuality: STATE.settings.jpegQuality,
                maxLongEdge: STATE.settings.maxLongEdge
            }
        });
        return true;
    }

    if (STATE.fallbackStep === 2 && STATE.settings.splitLimit === 0) {
        STATE.fallbackStep += 1;
        notifyPopup('Recovery limit reached. Suggest enabling split pages (e.g. 50).');
        chrome.runtime.sendMessage({
            action: 'JOB_ERROR',
            recoverable: false,
            error: `Recovery failed: ${message}. Please set split pages and retry.`
        }).catch(() => {});
        return false;
    }

    chrome.runtime.sendMessage({
        action: 'JOB_ERROR',
        recoverable: false,
        error: `Recovery failed: ${message}`
    }).catch(() => {});
    return false;
}

async function captureOneFrame(windowId, settings) {
    const options = { format: settings.captureFormat };
    if (settings.captureFormat === 'jpeg') {
        options.quality = settings.jpegQuality;
    }
    return chrome.tabs.captureVisibleTab(windowId, options);
}

async function captureAndDownload(windowId, pageNum) {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const filename = `kindle_capture_${String(pageNum).padStart(3, '0')}.png`;
    await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false
    });
}

function sendPageTurn(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'SC_TURN_PAGE' }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response);
        });
    });
}

function sendRuntimeMessage(payload) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(payload, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response && response.error) {
                reject(new Error(response.error));
                return;
            }
            resolve(response || {});
        });
    });
}

function notifyPopup(msg) {
    chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: msg }).catch(() => {});
}

function notifyMetrics(metrics) {
    chrome.runtime.sendMessage({ action: 'UPDATE_METRICS', metrics }).catch(() => {});
}

function buildStatusLine(request) {
    const proc = request.processingMs ? `${request.processingMs}ms` : '-';
    const sizeMb = request.estimatedBytes ? (request.estimatedBytes / (1024 * 1024)).toFixed(1) : '0.0';
    return `Stage: ${request.stage || 'running'} | proc=${proc} | est=${sizeMb}MB`;
}

function buildFilename(partIndex) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (partIndex) {
        return `kindle_book_${ts}_part${partIndex}.pdf`;
    }
    return `kindle_book_${ts}.pdf`;
}

function downloadPdf(url, filename) {
    return new Promise((resolve, reject) => {
        chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(downloadId);
        });
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
        return fallback;
    }
    return parsed;
}
