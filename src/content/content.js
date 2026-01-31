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
    // Strategy 1: Click "Next" button (RTL = Left side)
    const selectors = [
        '#KindleReader_PageTurnArea_Left',
        '.page-turn-area-left',
        '#kindleReader_pageTurnAreaLeft'
    ];

    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
            console.log('CS: Clicking selector (Left)', sel);
            el.click();
            return 'Clicked (Left) ' + sel;
        }
    }

    // Strategy 2: Keyboard ArrowLeft (RTL Next)
    console.log('CS: Simulating ArrowLeft');
    const keyEventInit = {
        key: 'ArrowLeft',
        code: 'ArrowLeft',
        keyCode: 37,
        which: 37,
        bubbles: true,
        cancelable: true,
        view: window
    };

    document.dispatchEvent(new KeyboardEvent('keydown', keyEventInit));
    document.dispatchEvent(new KeyboardEvent('keyup', keyEventInit));

    return 'Sent ArrowLeft Keys';
}
