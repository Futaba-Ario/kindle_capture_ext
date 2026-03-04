console.log('Kindle Capture Content Script Loaded');

const TURN_SELECTORS = {
    right: [
        '#KindleReader_PageTurnArea_Right',
        '#kindleReader_pageTurnAreaRight',
        '.page-turn-area-right',
        '[id*="pageTurnAreaRight"]'
    ],
    left: [
        '#KindleReader_PageTurnArea_Left',
        '#kindleReader_pageTurnAreaLeft',
        '.page-turn-area-left',
        '[id*="pageTurnAreaLeft"]'
    ]
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action !== 'SC_TURN_PAGE') {
        return false;
    }

    console.log('CS: Received message', request);
    try {
        const result = performPageTurn();
        sendResponse({
            status: `Turned via ${result.method}${result.detail ? ` (${result.detail})` : ''}`,
            method: result.method,
            detail: result.detail
        });
    } catch (error) {
        console.error(error);
        sendResponse({ status: 'Turn failed: ' + error.message });
    }

    return true;
});

function performPageTurn() {
    ensureReaderContext();

    const preferredSide = getPreferredTurnSide();
    const fallbackSide = preferredSide === 'right' ? 'left' : 'right';

    // 1) Selector click
    const selectorOrder = [...TURN_SELECTORS[preferredSide], ...TURN_SELECTORS[fallbackSide]];
    for (const selector of selectorOrder) {
        const element = document.querySelector(selector);
        if (!element) {
            continue;
        }

        console.log('CS: Clicking selector', selector);
        element.click();
        return { method: 'selector', detail: selector };
    }

    // 2) Coordinate click on a likely turn control
    const coordinateOrder = preferredSide === 'right'
        ? [
            { x: 0.95, side: 'right' },
            { x: 0.05, side: 'left' }
        ]
        : [
            { x: 0.05, side: 'left' },
            { x: 0.95, side: 'right' }
        ];

    for (const point of coordinateOrder) {
        const clickX = Math.floor(window.innerWidth * point.x);
        const clickY = Math.floor(window.innerHeight * 0.5);
        const target = findLikelyTurnTarget(clickX, clickY);

        if (!target) {
            continue;
        }

        console.log(`CS: Coordinate click at ${point.side} edge`, target);
        dispatchMouseClick(target, clickX, clickY);
        const targetName = `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}`;
        return { method: 'coordinate-click', detail: `${point.side}-edge-5%:${targetName}` };
    }

    // 3) Keyboard fallback
    const key = preferredSide === 'right' ? 'ArrowRight' : 'ArrowLeft';
    dispatchKeyboardTurn(key);
    return { method: 'keyboard', detail: key };
}

function ensureReaderContext() {
    if (window.location.pathname.includes('/landing')) {
        throw new Error('Kindle landing page is open. Open a book page first.');
    }
}

function getPreferredTurnSide() {
    const dir = (document.documentElement.getAttribute('dir') || '').toLowerCase();
    if (dir === 'rtl') {
        return 'left';
    }

    // Kindle日本語本は「次ページ=左送り」が多いため、ja系は左優先。
    const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase();
    const navLang = (navigator.language || '').toLowerCase();
    const host = window.location.hostname.toLowerCase();
    const isJapaneseContext = htmlLang.startsWith('ja') || navLang.startsWith('ja') || host.endsWith('amazon.co.jp');

    return isJapaneseContext ? 'left' : 'right';
}

function findLikelyTurnTarget(x, y) {
    const start = document.elementFromPoint(x, y);
    if (!start) {
        return null;
    }

    const chain = [];
    let node = start;
    for (let depth = 0; node && depth < 8; depth += 1) {
        if (node instanceof HTMLElement) {
            chain.push(node);
        }
        node = node.parentElement;
    }

    return chain.find((element) => isLikelyTurnControl(element)) || null;
}

function isLikelyTurnControl(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    const tag = element.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
        return false;
    }

    const idClass = `${element.id || ''} ${String(element.className || '')}`.toLowerCase();
    if (/pageturn|page-turn|page_turn|next|prev/.test(idClass)) {
        return true;
    }

    const ariaLabel = (element.getAttribute('aria-label') || '').toLowerCase();
    if (/next|prev|page|次|前/.test(ariaLabel)) {
        return true;
    }

    const role = (element.getAttribute('role') || '').toLowerCase();
    if (role === 'button') {
        return true;
    }

    if (typeof element.onclick === 'function') {
        return true;
    }

    const style = window.getComputedStyle(element);
    return style.cursor === 'pointer';
}

function dispatchMouseClick(target, x, y) {
    target.dispatchEvent(new MouseEvent('mousedown', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y
    }));

    target.dispatchEvent(new MouseEvent('mouseup', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y
    }));

    target.dispatchEvent(new MouseEvent('click', {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y
    }));
}

function dispatchKeyboardTurn(key) {
    const keyCode = key === 'ArrowRight' ? 39 : 37;
    const targets = [document.activeElement, document.body, document.documentElement]
        .filter(Boolean)
        .filter((value, index, array) => array.indexOf(value) === index);

    for (const target of targets) {
        target.dispatchEvent(new KeyboardEvent('keydown', {
            key,
            code: key,
            keyCode,
            bubbles: true,
            cancelable: true,
            view: window
        }));

        target.dispatchEvent(new KeyboardEvent('keyup', {
            key,
            code: key,
            keyCode,
            bubbles: true,
            cancelable: true,
            view: window
        }));
    }
}

