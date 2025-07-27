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
export function showNotification(message, backgroundColor = "#4a6cd4", duration = 3000) {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${backgroundColor};
        color: white;
        padding: 12px 16px;
        border-radius: 4px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        z-index: 10001;
        font-size: 14px;
    `;
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, duration);
    log.debug(`Notification shown: ${message}`);
}
/**
 * Shows a success notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showSuccessNotification(message, duration = 3000) {
    showNotification(message, "#4a7c59", duration);
}
/**
 * Shows an error notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 5000)
 */
export function showErrorNotification(message, duration = 5000) {
    showNotification(message, "#c54747", duration);
}
/**
 * Shows an info notification
 * @param message - The message to show
 * @param duration - Duration in milliseconds (default: 3000)
 */
export function showInfoNotification(message, duration = 3000) {
    showNotification(message, "#4a6cd4", duration);
}
