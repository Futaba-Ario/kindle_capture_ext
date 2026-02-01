// State
let isCapturing = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'CAPTURE_ONE') {
        handleCaptureOne(sendResponse);
        return true; // Keep channel open for async response
    } else if (request.action === 'TURN_PAGE') {
        handlePageTurn(sendResponse);
        return true;
    } else if (request.action === 'START_LOOP') {
        if (isCapturing) {
            sendResponse({ status: 'Already capturing' });
        } else {
            startCaptureLoop(request.pages, request.waitMs, request.splitLimit);
            sendResponse({ status: 'Loop started' });
        }
        return false;
    } else if (request.action === 'STOP_LOOP') {
        isCapturing = false;
        sendResponse({ status: 'Stop flag set' });
        return false;
    }
});

async function handlePageTurn(sendResponse) {
    // ... existing handlePageTurn logic reused or kept ...
    // Simplified for brevity in this replacement block, but ensuring we don't lose the wrapper
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) { sendResponse({ status: 'No active tab' }); return; }
        await sendPageTurn(tab.id);
        sendResponse({ status: 'Turned' });
    } catch (e) {
        sendResponse({ status: 'Error: ' + e.message });
    }
}

async function handleCaptureOne(sendResponse) {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) { sendResponse({ status: 'No active tab' }); return; }
        await captureAndDownload(tab.windowId, 1);
        sendResponse({ status: 'Captured' });
    } catch (e) {
        sendResponse({ status: 'Error: ' + e.message });
    }
}

const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';

async function setupOffscreenDocument(path) {
    // Check if offscreen document already exists
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(path)]
    });

    if (existingContexts.length > 0) {
        return;
    }

    // Create offscreen document
    if (chrome.offscreen) {
        await chrome.offscreen.createDocument({
            url: path,
            reasons: ['BLOBS'],
            justification: 'To generate PDF from captured images'
        });
    } else {
        // Fallback for older Chrome versions if needed, or error
        throw new Error('Offscreen API not available');
    }
}

async function startCaptureLoop(totalPages, waitMs = 1500, splitLimit = 0) {
    isCapturing = true;
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) {
            console.error('No active tab');
            isCapturing = false;
            return;
        }

        notifyPopup('Initializing PDF setup...');
        await setupOffscreenDocument(OFFSCREEN_DOCUMENT_PATH);

        // Initialize PDF in offscreen
        await chrome.runtime.sendMessage({ action: 'INIT_PDF' });

        let batchIndex = 1;
        let pagesInCurrentBatch = 0;

        for (let i = 0; i < totalPages; i++) {
            if (!isCapturing) break;

            // 1. Capture
            notifyPopup(`Capturing page ${i + 1}/${totalPages}...`);
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

            // Send to Offscreen
            await chrome.runtime.sendMessage({ action: 'ADD_PAGE', dataUrl: dataUrl });
            pagesInCurrentBatch++;

            // Check split logic
            if (splitLimit > 0 && pagesInCurrentBatch >= splitLimit && i < totalPages - 1) {
                notifyPopup(`Saving Batch ${batchIndex}...`);
                await savePdfBatch(batchIndex);
                batchIndex++;
                pagesInCurrentBatch = 0;
                await chrome.runtime.sendMessage({ action: 'INIT_PDF' });
            }

            if (i < totalPages - 1) {
                // 2. Turn Page
                notifyPopup(`Turning page ${i + 1}...`);
                await sendPageTurn(tab.id);

                // 3. Wait
                await new Promise(r => setTimeout(r, waitMs));
            }
        }

        if (isCapturing) {
            notifyPopup('Generating PDF...');
            // Request PDF Save
            if (splitLimit > 0) {
                await chrome.runtime.sendMessage({ action: 'SAVE_PDF', batchIndex: batchIndex });
            } else {
                await chrome.runtime.sendMessage({ action: 'SAVE_PDF' });
            }
        }

        isCapturing = false;

    } catch (e) {
        console.error(e);
        notifyPopup('Error: ' + e.message);
        isCapturing = false;
    }
}

// Listen for PDF generation completion
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PDF_GENERATED') {
        const dataUrl = request.dataUrl; // base64 pdf
        let filename;
        if (request.batchIndex) {
            filename = `kindle_book_${new Date().toISOString().replace(/[:.]/g, '-')}_part${request.batchIndex}.pdf`;
        } else {
            filename = `kindle_book_${new Date().toISOString().replace(/[:.]/g, '-')}.pdf`;
        }

        chrome.downloads.download({
            url: dataUrl,
            filename: filename,
            saveAs: false
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                notifyPopup('Download Error: ' + chrome.runtime.lastError.message);
            } else {
                notifyPopup('PDF Downloaded!');
            }
            // isCapturing = false; // logic moved to startCaptureLoop or handled there
        });
    }
});

async function captureAndDownload(windowId, pageNum) {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    const filename = `kindle_capture_${String(pageNum).padStart(3, '0')}.png`;

    // We want to await the download ID to ensure it's queued, 
    // but we don't strictly need to wait for completion for this PoC.
    await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false
    });
}

function sendPageTurn(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, { action: 'SC_TURN_PAGE' }, (response) => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
            } else {
                resolve(response);
            }
        });
    });
}

function notifyPopup(msg) {
    chrome.runtime.sendMessage({ action: 'UPDATE_STATUS', status: msg }).catch(() => {
        // Popup might be closed, ignore error
    });
}

function savePdfBatch(batchIndex) {
    return new Promise((resolve, reject) => {
        const handler = (request) => {
            if (request.action === 'PDF_GENERATED' && request.batchIndex === batchIndex) {
                chrome.runtime.onMessage.removeListener(handler);
                resolve();
            }
        };
        chrome.runtime.onMessage.addListener(handler);
        chrome.runtime.sendMessage({ action: 'SAVE_PDF', batchIndex: batchIndex });
    });
}
