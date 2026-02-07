console.log('Offscreen script loaded');

const DEFAULT_CONFIG = {
    captureFormat: 'jpeg',
    jpegQuality: 82,
    maxLongEdge: 2200,
    checkpointPages: 20
};

const JOB = {
    config: { ...DEFAULT_CONFIG },
    pdfDoc: null,
    checkpointChunks: [],
    pagesInDoc: 0,
    totalPages: 0,
    estimatedBytes: 0
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    void handleMessage(msg, sendResponse);
    return true;
});

async function handleMessage(msg, sendResponse) {
    try {
        if (msg.action === 'INIT_JOB') {
            await initJob(msg.config || {});
            sendResponse({ status: 'JOB_INITIALIZED' });
            return;
        }
        if (msg.action === 'UPDATE_JOB_CONFIG') {
            updateConfig(msg.config || {});
            sendStatus('config_updated', { processingMs: 0 });
            sendResponse({ status: 'JOB_CONFIG_UPDATED' });
            return;
        }
        if (msg.action === 'ADD_PAGE') {
            const processingMs = await addPage(msg.dataUrl, msg.captureFormat, msg.seq || 0);
            sendStatus('add_page', { processingMs });
            sendResponse({
                status: 'PAGE_ADDED',
                processingMs,
                estimatedBytes: JOB.estimatedBytes
            });
            return;
        }
        if (msg.action === 'CHECKPOINT_PDF') {
            await checkpointPdf();
            sendStatus('checkpoint', { processingMs: 0 });
            sendResponse({
                status: 'CHECKPOINTED',
                checkpointCount: JOB.checkpointChunks.length,
                estimatedBytes: JOB.estimatedBytes
            });
            return;
        }
        if (msg.action === 'FINALIZE_PDF') {
            const finalized = await finalizePdf(Boolean(msg.resetAfterFinalize));
            sendStatus('finalized', { processingMs: 0, estimatedBytes: finalized.estimatedBytes });
            sendResponse(finalized);
            return;
        }
        sendResponse({ error: `Unknown action: ${msg.action}` });
    } catch (e) {
        const errorText = e instanceof Error ? e.message : String(e);
        sendError(errorText, true);
        sendResponse({ error: errorText });
    }
}

async function initJob(config) {
    JOB.config = {
        captureFormat: config.captureFormat === 'png' ? 'png' : 'jpeg',
        jpegQuality: clampNumber(config.jpegQuality, 10, 100, DEFAULT_CONFIG.jpegQuality),
        maxLongEdge: Math.max(800, Number(config.maxLongEdge) || DEFAULT_CONFIG.maxLongEdge),
        checkpointPages: Math.max(1, Number(config.checkpointPages) || DEFAULT_CONFIG.checkpointPages)
    };
    JOB.checkpointChunks = [];
    JOB.pagesInDoc = 0;
    JOB.totalPages = 0;
    JOB.estimatedBytes = 0;
    JOB.pdfDoc = await PDFLib.PDFDocument.create();
}

function updateConfig(config) {
    if (typeof config.captureFormat === 'string') {
        JOB.config.captureFormat = config.captureFormat === 'png' ? 'png' : 'jpeg';
    }
    if (config.jpegQuality != null) {
        JOB.config.jpegQuality = clampNumber(config.jpegQuality, 10, 100, JOB.config.jpegQuality);
    }
    if (config.maxLongEdge != null) {
        JOB.config.maxLongEdge = Math.max(800, Number(config.maxLongEdge) || JOB.config.maxLongEdge);
    }
}

async function addPage(imageDataUrl, captureFormat, seq) {
    if (!JOB.pdfDoc) {
        JOB.pdfDoc = await PDFLib.PDFDocument.create();
    }

    const start = performance.now();
    const pageImage = await preprocessImageDataUrl(
        imageDataUrl,
        captureFormat || JOB.config.captureFormat,
        JOB.config.maxLongEdge,
        JOB.config.jpegQuality
    );

    const embeddedImage = pageImage.format === 'png'
        ? await JOB.pdfDoc.embedPng(pageImage.dataUrl)
        : await JOB.pdfDoc.embedJpg(pageImage.dataUrl);

    const page = JOB.pdfDoc.addPage([pageImage.width, pageImage.height]);
    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: pageImage.width,
        height: pageImage.height
    });

    JOB.pagesInDoc += 1;
    JOB.totalPages += 1;
    JOB.estimatedBytes += pageImage.approxBytes;

    sendStatus('page_ready', {
        seq,
        processingMs: Math.round(performance.now() - start)
    });

    return Math.round(performance.now() - start);
}

async function checkpointPdf() {
    if (!JOB.pdfDoc || JOB.pagesInDoc === 0) {
        return;
    }
    const bytes = await JOB.pdfDoc.save();
    JOB.checkpointChunks.push(bytes);
    JOB.estimatedBytes = JOB.checkpointChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    JOB.pdfDoc = await PDFLib.PDFDocument.create();
    JOB.pagesInDoc = 0;
}

async function finalizePdf(resetAfterFinalize) {
    if (!JOB.pdfDoc) {
        JOB.pdfDoc = await PDFLib.PDFDocument.create();
    }

    const allChunks = JOB.checkpointChunks.slice();
    if (JOB.pagesInDoc > 0) {
        allChunks.push(await JOB.pdfDoc.save());
    }

    if (allChunks.length === 0) {
        return {
            status: 'FINALIZED',
            dataUrl: '',
            estimatedBytes: 0
        };
    }

    let outputBytes;
    if (allChunks.length === 1) {
        outputBytes = allChunks[0];
    } else {
        const merged = await PDFLib.PDFDocument.create();
        for (const chunk of allChunks) {
            const src = await PDFLib.PDFDocument.load(chunk);
            const copiedPages = await merged.copyPages(src, src.getPageIndices());
            for (const copied of copiedPages) {
                merged.addPage(copied);
            }
        }
        outputBytes = await merged.save();
    }

    const dataUrl = await uint8ArrayToDataUrl(outputBytes);

    if (resetAfterFinalize) {
        JOB.checkpointChunks = [];
        JOB.pagesInDoc = 0;
        JOB.totalPages = 0;
        JOB.estimatedBytes = 0;
        JOB.pdfDoc = await PDFLib.PDFDocument.create();
    }

    return {
        status: 'FINALIZED',
        dataUrl,
        estimatedBytes: outputBytes.length
    };
}

async function preprocessImageDataUrl(inputDataUrl, captureFormat, maxLongEdge, jpegQuality) {
    const blob = await fetch(inputDataUrl).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);

    let targetWidth = bitmap.width;
    let targetHeight = bitmap.height;
    const longEdge = Math.max(targetWidth, targetHeight);
    if (longEdge > maxLongEdge) {
        const ratio = maxLongEdge / longEdge;
        targetWidth = Math.max(1, Math.round(targetWidth * ratio));
        targetHeight = Math.max(1, Math.round(targetHeight * ratio));
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) {
        throw new Error('Failed to create 2D canvas context');
    }
    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const outputFormat = captureFormat === 'png' ? 'png' : 'jpeg';
    const mime = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = outputFormat === 'png'
        ? canvas.toDataURL(mime)
        : canvas.toDataURL(mime, clampNumber(jpegQuality, 10, 100, 82) / 100);
    const approxBytes = Math.max(1, Math.floor((dataUrl.length * 3) / 4));

    return {
        dataUrl,
        width: targetWidth,
        height: targetHeight,
        format: outputFormat,
        approxBytes
    };
}

function uint8ArrayToDataUrl(pdfBytes) {
    return new Promise((resolve, reject) => {
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to convert PDF blob to DataURL'));
        reader.readAsDataURL(blob);
    });
}

function sendStatus(stage, extra) {
    chrome.runtime.sendMessage({
        action: 'JOB_STATUS',
        stage,
        totalPages: JOB.totalPages,
        estimatedBytes: JOB.estimatedBytes,
        ...extra
    }).catch(() => {});
}

function sendError(error, recoverable) {
    chrome.runtime.sendMessage({
        action: 'JOB_ERROR',
        recoverable: Boolean(recoverable),
        error
    }).catch(() => {});
}

function clampNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}
