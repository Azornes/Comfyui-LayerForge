import { createModuleLogger } from "./LoggerUtils.js";
const log = createModuleLogger('NotificationUtils');
// Store active notifications for deduplication
const activeNotifications = new Map();
/**
 * Utility functions for showing notifications to the user
 */
/**
 * Shows a temporary notification to the user
 * @param message - The message to show
 * @param backgroundColor - Background color (default: #4a6cd4)
 * @param duration - Duration in milliseconds (default: 3000)
 * @param type - Type of notification
 * @param deduplicate - If true, will not show duplicate messages and will refresh existing ones (default: false)
 */
export function showNotification(message, backgroundColor = "#4a6cd4", duration = 3000, type = "info", deduplicate = false) {
    // Remove any existing prefix to avoid double prefixing
    message = message.replace(/^\[Layer Forge\]\s*/, "");
    // If deduplication is enabled, check if this message already exists
    if (deduplicate) {
        const existingNotification = activeNotifications.get(message);
        if (existingNotification) {
            log.debug(`Notification already exists, refreshing timer: ${message}`);
            // Clear existing timeout
            if (existingNotification.timeout !== null) {
                clearTimeout(existingNotification.timeout);
            }
            // Find the progress bar and restart its animation
            const progressBar = existingNotification.element.querySelector('div[style*="animation"]');
            if (progressBar) {
                // Reset animation
                progressBar.style.animation = 'none';
                // Force reflow
                void progressBar.offsetHeight;
                // Restart animation
                progressBar.style.animation = `lf-progress ${duration / 1000}s linear`;
            }
            // Set new timeout
            const newTimeout = window.setTimeout(() => {
                const notification = existingNotification.element;
                notification.style.animation = 'lf-fadeout 0.3s ease-out forwards';
                notification.addEventListener('animationend', () => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                        activeNotifications.delete(message);
                        const container = document.getElementById('lf-notification-container');
                        if (container && container.children.length === 0) {
                            container.remove();
                        }
                    }
                });
            }, duration);
            existingNotification.timeout = newTimeout;
            return; // Don't create a new notification
        }
    }
    // Type-specific config
    const config = {
        success: { icon: "✔️", title: "Success", bg: "#1fd18b" },
        error: { icon: "❌", title: "Error", bg: "#ff6f6f" },
        info: { icon: "ℹ️", title: "Info", bg: "#4a6cd4" },
        warning: { icon: "⚠️", title: "Warning", bg: "#ffd43b" },
        alert: { icon: "⚠️", title: "Alert", bg: "#fff7cc" }
    }[type];
    // --- Get or create the main notification container ---
    let container = document.getElementById('lf-notification-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'lf-notification-container';
        container.style.cssText = `
            position: fixed;
            top: 24px;
            right: 24px;
            z-index: 10001;
            display: flex;
            flex-direction: row-reverse;
            gap: 16px;
            align-items: flex-start;
        `;
        document.body.appendChild(container);
    }
    // --- Dark, modern notification style ---
    const notification = document.createElement('div');
    notification.style.cssText = `
        min-width: 380px;
        max-width: 440px;
        max-height: 80vh;
        background: rgba(30, 32, 41, 0.9);
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 4px 32px rgba(0,0,0,0.25);
        display: flex;
        flex-direction: column;
        padding: 0;
        font-family: 'Segoe UI', 'Arial', sans-serif;
        overflow: hidden;
        border: 1px solid rgba(80, 80, 80, 0.5);
        backdrop-filter: blur(8px);
        animation: lf-fadein 0.3s ease-out;
    `;
    // --- Header (non-scrollable) ---
    const header = document.createElement('div');
    header.style.cssText = `display: flex; align-items: flex-start; padding: 16px 20px; position: relative; flex-shrink: 0;`;
    const leftBar = document.createElement('div');
    leftBar.style.cssText = `position: absolute; left: 0; top: 0; bottom: 0; width: 6px; background: ${config.bg}; box-shadow: 0 0 12px ${config.bg}; border-radius: 3px 0 0 3px;`;
    const iconContainer = document.createElement('div');
    iconContainer.style.cssText = `width: 48px; height: 48px; min-width: 48px; min-height: 48px; display: flex; align-items: center; justify-content: center; margin-left: 18px; margin-right: 18px;`;
    iconContainer.innerHTML = {
        success: `<svg width="48" height="48" viewBox="0 0 48 48"><defs><filter id="f-succ"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${config.bg}"/></filter></defs><path d="M24 4 L44 14 L44 34 L24 44 L4 34 L4 14 Z" fill="rgba(255,255,255,0.08)" stroke="${config.bg}" stroke-width="2"/><g filter="url(#f-succ)"><path d="M16 24 L22 30 L34 18" stroke="#fff" stroke-width="3" fill="none"/></g></svg>`,
        error: `<svg width="48" height="48" viewBox="0 0 48 48"><defs><filter id="f-err"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${config.bg}"/></filter></defs><path d="M14 14 L34 34 M34 14 L14 34" fill="none" stroke="#fff" stroke-width="3"/><g filter="url(#f-err)"><path d="M24,4 L42,12 L42,36 L24,44 L6,36 L6,12 Z" fill="rgba(255,255,255,0.08)" stroke="${config.bg}" stroke-width="2"/></g></svg>`,
        info: `<svg width="48" height="48" viewBox="0 0 48 48"><defs><filter id="f-info"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${config.bg}"/></filter></defs><path d="M24 14 L24 16 M24 22 L24 34" stroke="#fff" stroke-width="3" fill="none"/><g filter="url(#f-info)"><path d="M12,4 L36,4 L44,12 L44,36 L36,44 L12,44 L4,36 L4,12 Z" fill="rgba(255,255,255,0.08)" stroke="${config.bg}" stroke-width="2"/></g></svg>`,
        warning: `<svg width="48" height="48" viewBox="0 0 48 48"><defs><filter id="f-warn"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${config.bg}"/></filter></defs><path d="M24 14 L24 28 M24 34 L24 36" stroke="#fff" stroke-width="3" fill="none"/><g filter="url(#f-warn)"><path d="M24,4 L46,24 L24,44 L2,24 Z" fill="rgba(255,255,255,0.08)" stroke="${config.bg}" stroke-width="2"/></g></svg>`,
        alert: `<svg width="48" height="48" viewBox="0 0 48 48"><defs><filter id="f-alert"><feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${config.bg}"/></filter></defs><path d="M24 14 L24 28 M24 34 L24 36" stroke="#fff" stroke-width="3" fill="none"/><g filter="url(#f-alert)"><path d="M24,4 L46,24 L24,44 L2,24 Z" fill="rgba(255,255,255,0.08)" stroke="${config.bg}" stroke-width="2"/></g></svg>`
    }[type];
    const headerTextContent = document.createElement('div');
    headerTextContent.style.cssText = `display: flex; flex-direction: column; justify-content: center; flex: 1; min-width: 0;`;
    const titleSpan = document.createElement('div');
    titleSpan.style.cssText = `font-weight: 700; font-size: 16px; margin-bottom: 4px; color: #fff; text-transform: uppercase; letter-spacing: 0.5px;`;
    titleSpan.textContent = config.title;
    headerTextContent.appendChild(titleSpan);
    const topRightContainer = document.createElement('div');
    topRightContainer.style.cssText = `position: absolute; top: 14px; right: 18px; display: flex; align-items: center; gap: 12px;`;
    const tag = document.createElement('span');
    tag.style.cssText = `font-size: 11px; font-weight: 600; color: #fff; background: ${config.bg}; border-radius: 4px; padding: 2px 8px; box-shadow: 0 0 8px ${config.bg};`;
    tag.innerHTML = '🎨 Layer Forge';
    const getTextColorForBg = (hexColor) => {
        const r = parseInt(hexColor.slice(1, 3), 16), g = parseInt(hexColor.slice(3, 5), 16), b = parseInt(hexColor.slice(5, 7), 16);
        return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.5 ? '#000' : '#fff';
    };
    tag.style.color = getTextColorForBg(config.bg);
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute("aria-label", "Close notification");
    closeBtn.style.cssText = `background: none; border: none; color: #ccc; font-size: 22px; font-weight: bold; cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.15s; line-height: 1;`;
    topRightContainer.appendChild(tag);
    topRightContainer.appendChild(closeBtn);
    header.appendChild(iconContainer);
    header.appendChild(headerTextContent);
    header.appendChild(topRightContainer);
    // --- Scrollable Body ---
    const body = document.createElement('div');
    body.style.cssText = `padding: 0px 20px 16px 20px; overflow-y: auto; flex: 1;`;
    const msgSpan = document.createElement('div');
    msgSpan.style.cssText = `font-size: 14px; color: #ccc; line-height: 1.5; white-space: pre-wrap; word-break: break-word;`;
    msgSpan.textContent = message;
    body.appendChild(msgSpan);
    // --- Progress Bar ---
    const progressBar = document.createElement('div');
    progressBar.style.cssText = `height: 4px; width: 100%; background: ${config.bg}; box-shadow: 0 0 12px ${config.bg}; transform-origin: left; animation: lf-progress ${duration / 1000}s linear; flex-shrink: 0;`;
    // --- Assemble Notification ---
    notification.appendChild(leftBar);
    notification.appendChild(header);
    notification.appendChild(body);
    if (type === 'error') {
        const footer = document.createElement('div');
        footer.style.cssText = `padding: 0 20px 12px 86px; flex-shrink: 0;`;
        const copyButton = document.createElement('button');
        copyButton.textContent = 'Copy Error';
        copyButton.style.cssText = `background: rgba(255, 111, 111, 0.2); border: 1px solid #ff6f6f; color: #ffafaf; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; transition: background 0.2s;`;
        copyButton.onmouseenter = () => copyButton.style.background = 'rgba(255, 111, 111, 0.3)';
        copyButton.onmouseleave = () => copyButton.style.background = 'rgba(255, 111, 111, 0.2)';
        copyButton.onclick = () => {
            navigator.clipboard.writeText(message)
                .then(() => showSuccessNotification("Error message copied!", 2000))
                .catch(err => console.error('Failed to copy error message: ', err));
        };
        footer.appendChild(copyButton);
        notification.appendChild(footer);
    }
    notification.appendChild(progressBar);
    // Add to DOM
    container.appendChild(notification);
    // --- Keyframes and Timer Logic ---
    const styleSheet = document.getElementById('lf-notification-styles');
    if (!styleSheet) {
        const newStyleSheet = document.createElement("style");
        newStyleSheet.id = 'lf-notification-styles';
        newStyleSheet.innerText = `
            @keyframes lf-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }
            @keyframes lf-progress-rewind { to { transform: scaleX(1); } }
            @keyframes lf-fadein { from { opacity: 0; transform: scale(0.95) translateX(20px); } to { opacity: 1; transform: scale(1) translateX(0); } }
            @keyframes lf-fadeout { from { opacity: 1; transform: scale(1); } to { opacity: 0; transform: scale(0.95); } }
            .notification-scrollbar::-webkit-scrollbar { width: 8px; }
            .notification-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 4px; }
            .notification-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 4px; }
            .notification-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
        `;
        document.head.appendChild(newStyleSheet);
    }
    body.classList.add('notification-scrollbar');
    let dismissTimeout = null;
    const closeNotification = () => {
        // Remove from active notifications map if deduplicate is enabled
        if (deduplicate) {
            activeNotifications.delete(message);
        }
        notification.style.animation = 'lf-fadeout 0.3s ease-out forwards';
        notification.addEventListener('animationend', () => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
                if (container && container.children.length === 0) {
                    container.remove();
                }
            }
        });
    };
    closeBtn.onclick = closeNotification;
    const startDismissTimer = () => {
        dismissTimeout = window.setTimeout(closeNotification, duration);
        progressBar.style.animation = `lf-progress ${duration / 1000}s linear`;
    };
    const pauseAndRewindTimer = () => {
        if (dismissTimeout !== null)
            clearTimeout(dismissTimeout);
        dismissTimeout = null;
        const computedStyle = window.getComputedStyle(progressBar);
        progressBar.style.transform = computedStyle.transform;
        progressBar.style.animation = 'lf-progress-rewind 0.5s ease-out forwards';
    };
    notification.addEventListener('mouseenter', () => {
        pauseAndRewindTimer();
        // Update stored timeout if deduplicate is enabled
        if (deduplicate) {
            const stored = activeNotifications.get(message);
            if (stored) {
                stored.timeout = null;
            }
        }
    });
    notification.addEventListener('mouseleave', () => {
        startDismissTimer();
        // Update stored timeout if deduplicate is enabled
        if (deduplicate) {
            const stored = activeNotifications.get(message);
            if (stored) {
                stored.timeout = dismissTimeout;
            }
        }
    });
    startDismissTimer();
    // Store notification if deduplicate is enabled
    if (deduplicate) {
        activeNotifications.set(message, { element: notification, timeout: dismissTimeout });
    }
    log.debug(`Notification shown: [Layer Forge] ${message}`);
}
/**
 * Shows a success notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 * @param deduplicate - If true, will not show duplicate messages (default: false)
 */
export function showSuccessNotification(message, duration = 3000, deduplicate = false) {
    showNotification(message, undefined, duration, "success", deduplicate);
}
/**
 * Shows an error notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 5000)
 * @param deduplicate - If true, will not show duplicate messages (default: false)
 */
export function showErrorNotification(message, duration = 5000, deduplicate = false) {
    showNotification(message, undefined, duration, "error", deduplicate);
}
/**
 * Shows an info notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 * @param deduplicate - If true, will not show duplicate messages (default: false)
 */
export function showInfoNotification(message, duration = 3000, deduplicate = false) {
    showNotification(message, undefined, duration, "info", deduplicate);
}
/**
 * Shows a warning notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 * @param deduplicate - If true, will not show duplicate messages (default: false)
 */
export function showWarningNotification(message, duration = 3000, deduplicate = false) {
    showNotification(message, undefined, duration, "warning", deduplicate);
}
/**
 * Shows an alert notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 * @param deduplicate - If true, will not show duplicate messages (default: false)
 */
export function showAlertNotification(message, duration = 3000, deduplicate = false) {
    showNotification(message, undefined, duration, "alert", deduplicate);
}
/**
 * Shows a sequence of all notification types for debugging purposes.
 */
export function showAllNotificationTypes(message) {
    const types = ["success", "error", "info", "warning", "alert"];
    types.forEach((type, index) => {
        const notificationMessage = message || `This is a '${type}' notification.`;
        setTimeout(() => {
            showNotification(notificationMessage, undefined, 3000, type, false);
        }, index * 400); // Stagger the notifications
    });
}
