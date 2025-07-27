import {createModuleLogger} from "./LoggerUtils.js";
import { withErrorHandling, createValidationError, createNetworkError } from "../ErrorHandler.js";
import type { WebSocketMessage, AckCallbacks } from "../types.js";

const log = createModuleLogger('WebSocketManager');

class WebSocketManager {
    private socket: WebSocket | null;
    private messageQueue: string[];
    private isConnecting: boolean;
    private reconnectAttempts: number;
    private readonly maxReconnectAttempts: number;
    private readonly reconnectInterval: number;
    private ackCallbacks: AckCallbacks;
    private messageIdCounter: number;

    constructor(private url: string) {
        this.socket = null;
        this.messageQueue = [];
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectInterval = 5000; // 5 seconds
        this.ackCallbacks = new Map();
        this.messageIdCounter = 0;

        this.connect();
    }

    connect = withErrorHandling(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            log.debug("WebSocket is already open.");
            return;
        }

        if (this.isConnecting) {
            log.debug("Connection attempt already in progress.");
            return;
        }

        if (!this.url) {
            throw createValidationError("WebSocket URL is required", { url: this.url });
        }

        this.isConnecting = true;
        log.info(`Connecting to WebSocket at ${this.url}...`);

        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            log.info("WebSocket connection established.");
            this.flushMessageQueue();
        };

        this.socket.onmessage = (event: MessageEvent) => {
            try {
                const data: WebSocketMessage = JSON.parse(event.data);
                log.debug("Received message:", data);

                if (data.type === 'ack' && data.nodeId) {
                    const callback = this.ackCallbacks.get(data.nodeId);
                    if (callback) {
                        log.debug(`ACK received for nodeId: ${data.nodeId}, resolving promise.`);
                        callback.resolve(data);
                        this.ackCallbacks.delete(data.nodeId);
                    }
                }

            } catch (error) {
                log.error("Error parsing incoming WebSocket message:", error);
            }
        };

        this.socket.onclose = (event: CloseEvent) => {
            this.isConnecting = false;
            if (event.wasClean) {
                log.info(`WebSocket closed cleanly, code=${event.code}, reason=${event.reason}`);
            } else {
                log.warn("WebSocket connection died. Attempting to reconnect...");
                this.handleReconnect();
            }
        };

        this.socket.onerror = (error: Event) => {
            this.isConnecting = false;
            throw createNetworkError("WebSocket connection error", { error, url: this.url });
        };
    }, 'WebSocketManager.connect');

    handleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            log.info(`Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}...`);
            setTimeout(() => this.connect(), this.reconnectInterval);
        } else {
            log.error("Max reconnect attempts reached. Giving up.");
        }
    }

    sendMessage = withErrorHandling(async (data: WebSocketMessage, requiresAck = false): Promise<WebSocketMessage | void> => {
        if (!data || typeof data !== 'object') {
            throw createValidationError("Message data is required", { data });
        }

        const nodeId = data.nodeId;
        if (requiresAck && !nodeId) {
            throw createValidationError("A nodeId is required for messages that need acknowledgment", { data, requiresAck });
        }

        return new Promise((resolve, reject) => {
            const message = JSON.stringify(data);

            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(message);
                log.debug("Sent message:", data);
                if (requiresAck && nodeId) {
                    log.debug(`Message for nodeId ${nodeId} requires ACK. Setting up callback.`);

                    const timeout = setTimeout(() => {
                        this.ackCallbacks.delete(nodeId);
                        reject(createNetworkError(`ACK timeout for nodeId ${nodeId}`, { nodeId, timeout: 10000 }));
                        log.warn(`ACK timeout for nodeId ${nodeId}.`);
                    }, 10000); // 10-second timeout

                    this.ackCallbacks.set(nodeId, {
                        resolve: (responseData: WebSocketMessage | PromiseLike<WebSocketMessage>) => {
                            clearTimeout(timeout);
                            resolve(responseData);
                        },
                        reject: (error: any) => {
                            clearTimeout(timeout);
                            reject(error);
                        }
                    });
                } else {
                    resolve(); // Resolve immediately if no ACK is needed
                }
            } else {
                log.warn("WebSocket not open. Queuing message.");
                this.messageQueue.push(message);
                if (!this.isConnecting) {
                    this.connect();
                }

                if (requiresAck) {
                    reject(createNetworkError("Cannot send message with ACK required while disconnected", { 
                        socketState: this.socket?.readyState,
                        isConnecting: this.isConnecting 
                    }));
                } else {
                    resolve();
                }
            }
        });
    }, 'WebSocketManager.sendMessage');

    flushMessageQueue() {
        log.debug(`Flushing ${this.messageQueue.length} queued messages.`);

        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (this.socket && message) {
                this.socket.send(message);
            }
        }
    }
}

const wsUrl = `ws://${window.location.host}/layerforge/canvas_ws`;
export const webSocketManager = new WebSocketManager(wsUrl);
