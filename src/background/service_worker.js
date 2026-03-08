// State
let isCapturing = false;
let stopRequested = false;

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
const PDF_SAVE_TIMEOUT_MS = 30_000;
const MIN_CAPTURE_INTERVAL_MS = 550;
const CAPTURE_RETRY_DELAY_MS = 700;
const MAX_CAPTURE_RETRIES = 4;

let lastCaptureAtMs = 0;

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
        if (isCapturing) {
            sendResponse({ status: 'Already capturing' });
        } else {
            startCaptureLoop({
                mode: request.mode,
                manualPages: request.manualPages ?? request.pages,
                waitMs: request.waitMs,
                splitLimit: request.splitLimit
            }).catch((error) => {
                console.error('Capture loop failed unexpectedly:', error);
            });
            sendResponse({ status: 'Loop started' });
        }
        return false;
    }

    if (request.action === 'STOP_LOOP') {
        if (!isCapturing) {
            sendResponse({ status: 'Not capturing' });
            return false;
        }

        stopRequested = true;
        notifyPopup('Stop request accepted. Finishing current page...');
        sendResponse({ status: 'Stop request accepted. Partial PDF will be saved.' });
        return false;
    }

    return false;
});

chrome.runtime.onMessage.addListener((request) => {
    if (request.action === 'PDF_GENERATED') {
        const dataUrl = request.dataUrl;
        const partSuffix = request.batchIndex ? `_part${request.batchIndex}` : '';
        const filename = `kindle_book_${new Date().toISOString().replace(/[:.]/g, '-')}${partSuffix}.pdf`;

        chrome.downloads.download({
            url: dataUrl,
            filename,
            saveAs: false
        }, () => {
            if (chrome.runtime.lastError) {
                notifyPopup('Download Error: ' + chrome.runtime.lastError.message);
            } else if (request.batchIndex) {
                notifyPopup(`Part ${request.batchIndex} downloaded.`);
            } else {
                notifyPopup('PDF downloaded.');
            }
        });
    } else if (request.action === 'PDF_GENERATION_FAILED') {
        const partLabel = request.batchIndex ? ` (part ${request.batchIndex})` : '';
        notifyPopup(`PDF generation failed${partLabel}: ${request.error || 'Unknown error'}`);
    }
});

async function handlePageTurn(sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            sendResponse({ status: 'No active tab' });
            return;
        }

        const result = await sendPageTurn(tab.id);
        sendResponse({ status: result && result.status ? result.status : 'Turned' });
    } catch (error) {
        sendResponse({ status: 'Error: ' + error.message });
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
    } catch (error) {
        sendResponse({ status: 'Error: ' + error.message });
    }
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

async function startCaptureLoop(options = {}) {
    const captureMode = normalizeCaptureMode(options.mode);
    const manualTargetPages = parsePositiveInteger(options.manualPages);
    const turnWaitMs = Math.max(0, Number(options.waitMs) || 1500);
    const splitPageLimit = Math.max(0, Number(options.splitLimit) || 0);

    if (captureMode === 'manual' && manualTargetPages === null) {
        throw new Error('Manual mode requires a page count of 1 or more.');
    }

    const session = {
        tab: null,
        turnWaitMs,
        splitPageLimit,
        batchIndex: 1,
        pagesInCurrentBatch: 0,
        capturedPages: 0,
        isSavingPdf: false
    };

    isCapturing = true;
    stopRequested = false;

    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            throw new Error('No active tab');
        }
        session.tab = tab;

        notifyPopup('Initializing PDF setup...');
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
        await sendRuntimeMessage({ action: 'INIT_PDF' });

        if (captureMode === 'auto') {
            await runAutoCapture(session);
        } else {
            notifyPopup(`Starting manual capture for ${manualTargetPages} pages.`);
            await runManualCapture(session, manualTargetPages);
        }

        await finalizePendingPdf(session, stopRequested ? 'stop' : 'complete');

        if (stopRequested) {
            if (session.capturedPages > 0) {
                notifyPopup('Stopped. Partial PDF saved.');
            } else {
                notifyPopup('Stopped before capturing any pages.');
            }
        } else {
            notifyPopup('Capture complete.');
        }
    } catch (error) {
        console.error(error);
        await handleCaptureLoopError(error, session);
    } finally {
        isCapturing = false;
        stopRequested = false;
    }
}

async function captureAndDownload(windowId, pageNum) {
    const dataUrl = await captureVisibleTabWithThrottle(windowId);
    const filename = `kindle_capture_${String(pageNum).padStart(3, '0')}.png`;

    await chrome.downloads.download({
        url: dataUrl,
        filename,
        saveAs: false
    });
}

function sendPageTurn(tabId) {
    return sendTopFrameMessage(tabId, { action: 'SC_TURN_PAGE' }).then((response) => {
        if (response && response.status && response.status.startsWith('Turn failed')) {
            throw new Error(response.status);
        }

        return response || { status: 'Turned' };
    });
}

function getReaderProgress(tabId) {
    return sendTopFrameMessage(tabId, { action: 'SC_GET_READER_PROGRESS' }).then((response) => {
        if (!response || !Number.isInteger(response.currentPage) || !Number.isInteger(response.totalPages) || typeof response.source !== 'string') {
            const errorMessage = response && response.status ? response.status : 'Reader progress unavailable';
            throw new Error(errorMessage);
        }

        return response;
    });
}

function sendTopFrameMessage(tabId, message) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
            if (chrome.runtime.lastError) {
                const lastErrorMessage = chrome.runtime.lastError.message || 'Unknown tab messaging error';
                if (lastErrorMessage.includes('Could not establish connection')) {
                    reject(new Error('Top-frame content script connection failed: ' + lastErrorMessage));
                    return;
                }
                reject(new Error(lastErrorMessage));
                return;
            }

            resolve(response);
        });
    });
}

function savePdfAndWait(expectedBatchIndex, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
            chrome.runtime.onMessage.removeListener(handler);
        };

        const settle = (callback, value) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            callback(value);
        };

        const handler = (request) => {
            if (request.action === 'PDF_GENERATED' && isExpectedBatch(request.batchIndex, expectedBatchIndex)) {
                settle(resolve);
            } else if (request.action === 'PDF_GENERATION_FAILED' && isExpectedBatch(request.batchIndex, expectedBatchIndex)) {
                settle(reject, new Error(request.error || 'PDF generation failed'));
            }
        };

        chrome.runtime.onMessage.addListener(handler);

        timeoutId = setTimeout(() => {
            const partLabel = expectedBatchIndex ? ` for part ${expectedBatchIndex}` : '';
            settle(reject, new Error(`Timed out waiting for PDF generation${partLabel}`));
        }, timeoutMs);

        const message = expectedBatchIndex ? { action: 'SAVE_PDF', batchIndex: expectedBatchIndex } : { action: 'SAVE_PDF' };
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                settle(reject, new Error(chrome.runtime.lastError.message));
                return;
            }

            if (response && typeof response.status === 'string' && response.status.startsWith('Error')) {
                settle(reject, new Error(response.status));
            }
        });
    });
}

function isExpectedBatch(receivedBatchIndex, expectedBatchIndex) {
    if (expectedBatchIndex === undefined || expectedBatchIndex === null) {
        return receivedBatchIndex === undefined || receivedBatchIndex === null;
    }
    return receivedBatchIndex === expectedBatchIndex;
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            if (response && typeof response.status === 'string' && response.status.startsWith('Error')) {
                reject(new Error(response.status));
                return;
            }

            resolve(response);
        });
    });
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCaptureMode(value) {
    if (value === undefined || value === null || value === '') {
        return 'auto';
    }

    if (value === 'auto' || value === 'manual') {
        return value;
    }

    throw new Error(`Unknown capture mode: ${value}`);
}

function parsePositiveInteger(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function captureVisibleTabWithThrottle(windowId) {
    const now = Date.now();
    const elapsed = now - lastCaptureAtMs;
    if (elapsed < MIN_CAPTURE_INTERVAL_MS) {
        await delay(MIN_CAPTURE_INTERVAL_MS - elapsed);
    }

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_CAPTURE_RETRIES; attempt++) {
        try {
            const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
            lastCaptureAtMs = Date.now();
            return dataUrl;
        } catch (error) {
            lastError = error;
            const message = String(error && error.message ? error.message : error);
            const quotaHit = message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');

            if (!quotaHit || attempt === MAX_CAPTURE_RETRIES) {
                throw error;
            }

            notifyPopup('Capture quota reached. Retrying...');
            await delay(CAPTURE_RETRY_DELAY_MS);
        }
    }

    throw lastError || new Error('captureVisibleTab failed');
}

function notifyPopup(msg) {
    chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: msg }).catch(() => {
        // Popup might be closed.
    });
}

async function runAutoCapture(session) {
    notifyPopup('Detecting reader progress...');

    let detectedProgress;
    try {
        detectedProgress = await getReaderProgress(session.tab.id);
    } catch (error) {
        throw new Error(`Auto mode could not detect reader progress: ${error.message}`);
    }

    notifyPopup(`Detected current ${detectedProgress.currentPage}/${detectedProgress.totalPages} via ${detectedProgress.source}.`);
    await runProgressAwareCapture(session, detectedProgress);
}

async function runProgressAwareCapture(session, initialProgress) {
    let progress = initialProgress;

    while (!stopRequested) {
        notifyPopup(`Capturing page ${progress.currentPage}/${progress.totalPages}...`);
        await captureCurrentPage(session);

        const hasMorePages = progress.currentPage < progress.totalPages;
        await maybeSaveSplitBatch(session, hasMorePages && !stopRequested);

        if (!hasMorePages || stopRequested) {
            return;
        }

        notifyPopup(`Turning page ${progress.currentPage}/${progress.totalPages}...`);
        const turnResult = await sendPageTurn(session.tab.id);
        if (turnResult && turnResult.status) {
            notifyPopup(turnResult.status);
        }

        if (session.turnWaitMs > 0) {
            await delay(session.turnWaitMs);
        }

        const nextProgress = await getReaderProgress(session.tab.id);
        if (nextProgress.currentPage <= progress.currentPage) {
            throw new Error(`Reader progress did not advance after page turn (${progress.currentPage}/${progress.totalPages} -> ${nextProgress.currentPage}/${nextProgress.totalPages}).`);
        }

        progress = nextProgress;
    }
}

async function runManualCapture(session, targetPages) {
    for (let i = 0; i < targetPages; i++) {
        if (stopRequested) {
            return;
        }

        notifyPopup(`Capturing page ${i + 1}/${targetPages}...`);
        await captureCurrentPage(session);

        const hasMorePages = i < targetPages - 1;
        await maybeSaveSplitBatch(session, hasMorePages && !stopRequested);

        if (!hasMorePages || stopRequested) {
            return;
        }

        notifyPopup(`Turning page ${i + 1}/${targetPages}...`);
        const turnResult = await sendPageTurn(session.tab.id);
        if (turnResult && turnResult.status) {
            notifyPopup(turnResult.status);
        }

        if (session.turnWaitMs > 0) {
            await delay(session.turnWaitMs);
        }
    }
}

async function captureCurrentPage(session) {
    const dataUrl = await captureVisibleTabWithThrottle(session.tab.windowId);
    await sendRuntimeMessage({ action: 'ADD_PAGE', dataUrl });
    session.pagesInCurrentBatch++;
    session.capturedPages++;
}

async function maybeSaveSplitBatch(session, shouldContinue) {
    if (session.splitPageLimit <= 0 || session.pagesInCurrentBatch < session.splitPageLimit || !shouldContinue) {
        return;
    }

    notifyPopup(`Saving part ${session.batchIndex}...`);
    await saveCurrentBatch(session, session.batchIndex);
    session.batchIndex++;
    session.pagesInCurrentBatch = 0;

    if (!stopRequested) {
        await sendRuntimeMessage({ action: 'INIT_PDF' });
    }
}

async function finalizePendingPdf(session, reason) {
    if (session.pagesInCurrentBatch <= 0) {
        return false;
    }

    if (reason === 'stop') {
        notifyPopup('Saving partial PDF before stop...');
    } else if (reason === 'error') {
        notifyPopup('Saving partial PDF after error...');
    } else {
        notifyPopup('Generating PDF...');
    }

    const finalBatchIndex = session.splitPageLimit > 0 ? session.batchIndex : undefined;
    await saveCurrentBatch(session, finalBatchIndex);
    session.pagesInCurrentBatch = 0;
    return true;
}

async function saveCurrentBatch(session, batchIndex) {
    session.isSavingPdf = true;
    try {
        await savePdfAndWait(batchIndex, PDF_SAVE_TIMEOUT_MS);
    } finally {
        session.isSavingPdf = false;
    }
}

async function handleCaptureLoopError(error, session) {
    let errorMessage = error instanceof Error ? error.message : String(error);

    if (session && session.pagesInCurrentBatch > 0 && !session.isSavingPdf) {
        try {
            await finalizePendingPdf(session, 'error');
            errorMessage += ' Partial PDF saved.';
        } catch (saveError) {
            console.error('Failed to save partial PDF after error:', saveError);
            const saveMessage = saveError instanceof Error ? saveError.message : String(saveError);
            errorMessage += ` Partial PDF save failed: ${saveMessage}`;
        }
    }

    notifyPopup('Error: ' + errorMessage);
}



