console.log('Kindle Capture Content Script Loaded');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log('CS: Received message', request);
    if (request.action === 'SC_TURN_PAGE') {
        try {
            const result = performPageTurn();
            sendResponse({ status: result });
        } catch (e) {
            console.error(e);
            sendResponse({ status: 'Turn failed: ' + e.message });
        }
    }
    // Note: returning true is important if we were async, but we match logic elsewhere.
    // For consistency with typical patterns, we return true if we plan to reply.
    return true;
});

function performPageTurn() {
    console.log('CS: Attempting Page Turn...');

    // 1. Try generic legacy selectors
    const selectors = [
        '#KindleReader_PageTurnArea_Left',
        '.page-turn-area-left',
        '#kindleReader_pageTurnAreaLeft',
        '#kindleReader_pageTurnAreaRight', // Just in case it's LTR and user wants to go next
        '.page-turn-area-right'
    ];

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
            console.log('CS: Clicking selector', sel);
            el.click();
            return 'Clicked ' + sel;
        }
    }

    // 2. Click by coordinates (Left edge for RTL, Right edge for LTR)
    // We try LEFT first as this is likely for Japanese vertical text
    try {
        const x = window.innerWidth * 0.05; // 5% from left
        const y = window.innerHeight * 0.5;
        const el = document.elementFromPoint(x, y);
        if (el) {
            console.log('CS: Clicking element at 5%', el);
            const clickEvent = new MouseEvent('click', {
                view: window,
                bubbles: true,
                cancelable: true,
                clientX: x,
                clientY: y
            });
            el.dispatchEvent(clickEvent);
            // Also try plain .click() if available
            // el.click(); 
        }
    } catch (e) {
        console.error('CS: Coordinate click failed', e);
    }

    // 3. Keyboard ArrowLeft (RTL Next)
    // Send to both document and activeElement
    const targets = [document.body, document.documentElement];
    if (document.activeElement && document.activeElement !== document.body) {
        targets.unshift(document.activeElement);
    }

    const key = 'ArrowLeft'; // Change to ArrowRight if LTR
    const code = 'ArrowLeft';
    const keyCode = 37;

    for (const target of targets) {
        console.log('CS: Dispatching keys to', target);
        target.dispatchEvent(new KeyboardEvent('keydown', { key, code, keyCode, bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key, code, keyCode, bubbles: true, cancelable: true, view: window }));
    }

    return 'Dispatched Events';
}
