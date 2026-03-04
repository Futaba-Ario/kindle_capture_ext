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
            startCaptureLoop(request.pages, request.waitMs, request.splitLimit).catch((error) => {
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

async function startCaptureLoop(totalPages, waitMs = 1500, splitLimit = 0) {
    const targetPages = Math.max(1, Number(totalPages) || 1);
    const turnWaitMs = Math.max(0, Number(waitMs) || 1500);
    const splitPageLimit = Math.max(0, Number(splitLimit) || 0);

    isCapturing = true;
    stopRequested = false;

    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            throw new Error('No active tab');
        }

        notifyPopup('Initializing PDF setup...');
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);
        await sendRuntimeMessage({ action: 'INIT_PDF' });

        let batchIndex = 1;
        let pagesInCurrentBatch = 0;
        let capturedPages = 0;

        for (let i = 0; i < targetPages; i++) {
            if (stopRequested) {
                break;
            }

            notifyPopup(`Capturing page ${i + 1}/${targetPages}...`);
            const dataUrl = await captureVisibleTabWithThrottle(tab.windowId);
            await sendRuntimeMessage({ action: 'ADD_PAGE', dataUrl });

            pagesInCurrentBatch++;
            capturedPages++;

            if (splitPageLimit > 0 && pagesInCurrentBatch >= splitPageLimit && i < targetPages - 1) {
                notifyPopup(`Saving part ${batchIndex}...`);
                await savePdfAndWait(batchIndex, PDF_SAVE_TIMEOUT_MS);

                batchIndex++;
                pagesInCurrentBatch = 0;

                if (!stopRequested) {
                    await sendRuntimeMessage({ action: 'INIT_PDF' });
                }
            }

            if (i < targetPages - 1 && !stopRequested) {
                notifyPopup(`Turning page ${i + 1}...`);
                const turnResult = await sendPageTurn(tab.id);
                if (turnResult && turnResult.status) {
                    notifyPopup(turnResult.status);
                }

                if (turnWaitMs > 0) {
                    await delay(turnWaitMs);
                }
            }
        }

        if (pagesInCurrentBatch > 0) {
            if (stopRequested) {
                notifyPopup('Saving partial PDF before stop...');
            } else {
                notifyPopup('Generating PDF...');
            }

            const finalBatchIndex = splitPageLimit > 0 ? batchIndex : undefined;
            await savePdfAndWait(finalBatchIndex, PDF_SAVE_TIMEOUT_MS);
        }

        if (stopRequested) {
            if (capturedPages > 0) {
                notifyPopup('Stopped. Partial PDF saved.');
            } else {
                notifyPopup('Stopped before capturing any pages.');
            }
        } else {
            notifyPopup('Capture complete.');
        }
    } catch (error) {
        console.error(error);
        notifyPopup('Error: ' + error.message);
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
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'SC_TURN_PAGE' }, { frameId: 0 }, (response) => {
            if (chrome.runtime.lastError) {
                const message = chrome.runtime.lastError.message || 'Unknown tab messaging error';
                if (message.includes('Could not establish connection')) {
                    reject(new Error('Top-frame content script connection failed: ' + message));
                    return;
                }
                reject(new Error(message));
                return;
            }

            if (response && response.status && response.status.startsWith('Turn failed')) {
                reject(new Error(response.status));
                return;
            }

            resolve(response || { status: 'Turned' });
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
