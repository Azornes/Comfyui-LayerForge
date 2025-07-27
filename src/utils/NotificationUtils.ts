import { createModuleLogger } from "./LoggerUtils.js";

const log = createModuleLogger('NotificationUtils');

/**
 * Utility functions for showing notifications to the user
 */

/**
 * Shows a temporary notification to the user
 * @param message - The message to show
 * @param backgroundColor - Background color (default: #4a6cd4)
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showNotification(
    message: string,
    backgroundColor: string = "#4a6cd4",
    duration: number = 3000,
    type: "success" | "error" | "info" | "warning" | "alert" = "info"
): void {
    // Remove any existing prefix to avoid double prefixing
    message = message.replace(/^\[Layer Forge\]\s*/, "");

    // Type-specific config
    const config = {
        success: {
            icon: "✔️",
            title: "Success",
            bg: "#1fd18b",
            color: "#155c3b"
        },
        error: {
            icon: "❌",
            title: "Error",
            bg: "#ff6f6f",
            color: "#7a2323"
        },
        info: {
            icon: "ℹ️",
            title: "Info",
            bg: "#4a6cd4",
            color: "#fff"
        },
        warning: {
            icon: "⚠️",
            title: "Warning",
            bg: "#ffd43b",
            color: "#7a5c00"
        },
        alert: {
            icon: "⚠️",
            title: "Alert",
            bg: "#fff7cc",
            color: "#7a5c00"
        }
    }[type];

    // --- Dark, modern notification style with sticky header ---
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 24px;
        right: 24px;
        min-width: 380px;
        max-width: 440px;
        max-height: 80vh;
        background: rgba(30, 32, 41, 0.9);
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 4px 32px rgba(0,0,0,0.25);
        z-index: 10001;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        padding: 0;
        margin-bottom: 18px;
        font-family: 'Segoe UI', 'Arial', sans-serif;
        overflow: hidden;
        border: 1px solid rgba(80, 80, 80, 0.5);
        backdrop-filter: blur(8px);
        animation: lf-fadein 0.2s;
    `;

    // --- Header (non-scrollable) ---
    const header = document.createElement('div');
    header.style.cssText = `
        display: flex;
        align-items: flex-start;
        padding: 16px 20px;
        position: relative;
        flex-shrink: 0;
    `;

    const leftBar = document.createElement('div');
    leftBar.style.cssText = `
        position: absolute;
        left: 0; top: 0; bottom: 0;
        width: 6px;
        background: ${config.bg};
        box-shadow: 0 0 12px ${config.bg};
        border-radius: 3px 0 0 3px;
    `;

    const iconContainer = document.createElement('div');
    iconContainer.style.cssText = `
        width: 48px; height: 48px;
        min-width: 48px; min-height: 48px;
        display: flex; align-items: center; justify-content: center;
        margin-left: 18px; margin-right: 18px;
    `;
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
    const getTextColorForBg = (hexColor: string): string => {
        const r = parseInt(hexColor.slice(1, 3), 16), g = parseInt(hexColor.slice(3, 5), 16), b = parseInt(hexColor.slice(5, 7), 16);
        return ((0.299 * r + 0.587 * g + 0.114 * b) / 255) > 0.5 ? '#000' : '#fff';
    };
    tag.style.color = getTextColorForBg(config.bg);
    
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute("aria-label", "Close notification");
    closeBtn.style.cssText = `background: none; border: none; color: #ccc; font-size: 22px; font-weight: bold; cursor: pointer; padding: 0; opacity: 0.7; transition: opacity 0.15s; line-height: 1;`;
    closeBtn.onclick = () => { if (notification.parentNode) notification.parentNode.removeChild(notification); };
    
    topRightContainer.appendChild(tag);
    topRightContainer.appendChild(closeBtn);

    header.appendChild(iconContainer);
    header.appendChild(headerTextContent);
    header.appendChild(topRightContainer);

    // --- Scrollable Body ---
    const body = document.createElement('div');
    body.style.cssText = `
        padding: 0px 20px 16px 20px; /* Adjusted left padding */
        overflow-y: auto;
        flex: 1;
    `;
    
    const msgSpan = document.createElement('div');
    msgSpan.style.cssText = `font-size: 14px; color: #ccc; line-height: 1.5; white-space: pre-wrap; word-break: break-word;`;
    msgSpan.textContent = message;
    body.appendChild(msgSpan);
    
    // --- Progress Bar (non-scrollable) ---
    const progressBar = document.createElement('div');
    progressBar.style.cssText = `
        height: 4px;
        width: 100%;
        background: ${config.bg};
        box-shadow: 0 0 12px ${config.bg};
        transform-origin: left;
        animation: lf-progress ${duration / 1000}s linear;
        flex-shrink: 0;
    `;

    notification.appendChild(leftBar); // Add bar to main container
    notification.appendChild(header);
    notification.appendChild(body);
    notification.appendChild(progressBar);
    document.body.appendChild(notification);

    // --- Keyframes and Timer Logic ---
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = `
        @keyframes lf-progress { from { transform: scaleX(1); } to { transform: scaleX(0); } }
        @keyframes lf-progress-rewind { to { transform: scaleX(1); } }
        @keyframes lf-fadein { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }
        .notification-scrollbar::-webkit-scrollbar { width: 8px; }
        .notification-scrollbar::-webkit-scrollbar-track { background: rgba(0,0,0,0.2); border-radius: 4px; }
        .notification-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.25); border-radius: 4px; }
        .notification-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.4); }
    `;
    body.classList.add('notification-scrollbar');
    document.head.appendChild(styleSheet);

    let dismissTimeout: number | null = null;
    const startDismissTimer = () => {
        dismissTimeout = window.setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, duration);
        progressBar.style.animation = `lf-progress ${duration / 1000}s linear`;
    };
    const pauseAndRewindTimer = () => {
        if (dismissTimeout !== null) clearTimeout(dismissTimeout);
        dismissTimeout = null;
        const computedStyle = window.getComputedStyle(progressBar);
        progressBar.style.transform = computedStyle.transform;
        progressBar.style.animation = 'lf-progress-rewind 0.5s ease-out forwards';
    };
    notification.addEventListener('mouseenter', pauseAndRewindTimer);
    notification.addEventListener('mouseleave', startDismissTimer);
    startDismissTimer();

    log.debug(`Notification shown: [Layer Forge] ${message}`);
}

/**
 * Shows a success notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showSuccessNotification(message: string, duration: number = 3000): void {
    showNotification(message, undefined, duration, "success");
}

/**
 * Shows an error notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 5000)
 */
export function showErrorNotification(message: string, duration: number = 5000): void {
    showNotification(message, undefined, duration, "error");
}

/**
 * Shows an info notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showInfoNotification(message: string, duration: number = 3000): void {
    showNotification(message, undefined, duration, "info");
}

/**
 * Shows a warning notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showWarningNotification(message: string, duration: number = 3000): void {
    showNotification(message, undefined, duration, "warning");
}

/**
 * Shows an alert notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showAlertNotification(message: string, duration: number = 3000): void {
    showNotification(message, undefined, duration, "alert");
}

/**
 * Shows a sequence of all notification types for debugging purposes.
 * @param message - An optional message to display in all notification types.
 */
export function showAllNotificationTypes(message?: string): void {
    const types: ("success" | "error" | "info" | "warning" | "alert")[] = ["success", "error", "info", "warning", "alert"];
    
    types.forEach((type, index) => {
        const notificationMessage = message || `This is a '${type}' notification.`;
        setTimeout(() => {
            switch (type) {
                case "success":
                    showSuccessNotification(notificationMessage);
                    break;
                case "error":
                    showErrorNotification(notificationMessage);
                    break;
                case "info":
                    showInfoNotification(notificationMessage);
                    break;
                case "warning":
                    showWarningNotification(notificationMessage);
                    break;
                case "alert":
                    showAlertNotification(notificationMessage);
                    break;
            }
        }, index * 400); // Stagger the notifications
    });
}
