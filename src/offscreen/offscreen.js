// Offscreen script to handle PDF generation
console.log('Offscreen script loaded');

let pdfDoc = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'INIT_PDF') {
        initPdf().then(() => {
            sendResponse({ status: 'PDF Initialized' });
        }).catch((error) => {
            sendResponse({ status: 'Error initializing PDF: ' + error.message });
        });
        return true;
    }

    if (msg.action === 'ADD_PAGE') {
        addPage(msg.dataUrl).then(() => {
            sendResponse({ status: 'Page Added' });
        }).catch((error) => {
            sendResponse({ status: 'Error adding page: ' + error.message });
        });
        return true;
    }

    if (msg.action === 'SAVE_PDF') {
        savePdf(msg.batchIndex).then(() => {
            sendResponse({ status: 'Generating PDF...' });
        }).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            sendPdfGenerationFailed(message, msg.batchIndex);
            sendResponse({ status: 'Error saving PDF: ' + message });
        });
        return true;
    }

    return false;
});

async function initPdf() {
    pdfDoc = await PDFLib.PDFDocument.create();
    console.log('New PDF Document created');
}

async function addPage(imageDataUrl) {
    if (!pdfDoc) {
        await initPdf();
    }

    const pngImage = await pdfDoc.embedPng(imageDataUrl);
    const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
    page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pngImage.width,
        height: pngImage.height
    });
}

async function savePdf(batchIndex) {
    if (!pdfDoc) {
        throw new Error('PDF is not initialized');
    }

    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const dataUrl = await blobToDataUrl(blob);

    await sendRuntimeMessage({
        action: 'PDF_GENERATED',
        dataUrl,
        batchIndex
    });
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onloadend = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
                return;
            }
            reject(new Error('Failed to convert PDF blob to data URL'));
        };

        reader.onerror = () => {
            reject(new Error('FileReader failed while converting PDF blob'));
        };

        reader.readAsDataURL(blob);
    });
}

function sendPdfGenerationFailed(error, batchIndex) {
    chrome.runtime.sendMessage({
        action: 'PDF_GENERATION_FAILED',
        batchIndex,
        error
    }).catch(() => {
        // Background may restart before receiving this signal.
    });
}

function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }

            resolve(response);
        });
    });
}
