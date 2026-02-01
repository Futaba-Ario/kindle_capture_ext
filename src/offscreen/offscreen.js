// Offscreen script to handle PDF generation
console.log('Offscreen script loaded');

let pdfDoc = null;

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.action === 'INIT_PDF') {
        await initPdf();
        sendResponse({ status: 'PDF Initialized' });
    } else if (msg.action === 'ADD_PAGE') {
        try {
            await addPage(msg.dataUrl);
            sendResponse({ status: 'Page Added' });
        } catch (e) {
            sendResponse({ status: 'Error adding page: ' + e.message });
        }
    } else if (msg.action === 'SAVE_PDF') {
        try {
            const pdfBytes = await pdfDoc.save();
            // Convert to base64 to send back to SW or trigger download blob URL loop?
            // Actually, offscreen can't use chrome.downloads directly often, but it can create a blob URL.
            // However, passing receiving blob URL in SW is tricky.
            // Easiest for small-medium PDF: Send base64 back to SW.
            // Large PDF: SW might crash.
            // Better: Offscreen creates Blob, URL, and tries to start download? 
            // Offscreen has access to DOM, so:
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });
            const url = URL.createObjectURL(blob);

            // We can't use chrome.downloads in offscreen? Manifest says "downloads" permission. 
            // But typically we msg the SW to download.
            // Let's Convert to Base64 string to keep it simple for now, as planned.
            // If it fails on memory, we optimize.

            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
                const base64data = reader.result;
                chrome.runtime.sendMessage({
                    action: 'PDF_GENERATED',
                    dataUrl: base64data,
                    batchIndex: msg.batchIndex
                });
            };

            sendResponse({ status: 'Generating PDF...' });
        } catch (e) {
            sendResponse({ status: 'Error saving PDF: ' + e.message });
        }
    }
    return true;
});

async function initPdf() {
    pdfDoc = await PDFLib.PDFDocument.create();
    console.log('New PDF Document created');
}

async function addPage(imageDataUrl) {
    if (!pdfDoc) await initPdf();

    const pngImage = await pdfDoc.embedPng(imageDataUrl);
    const page = pdfDoc.addPage([pngImage.width, pngImage.height]);
    page.drawImage(pngImage, {
        x: 0,
        y: 0,
        width: pngImage.width,
        height: pngImage.height,
    });
}
