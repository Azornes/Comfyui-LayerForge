/**
 * Logger - Centralny system logowania dla ComfyUI-LayerForge
 * 
 * Funkcje:
 * - Różne poziomy logowania (DEBUG, INFO, WARN, ERROR)
 * - Możliwość włączania/wyłączania logów globalnie lub per moduł
 * - Kolorowe logi w konsoli
 * - Możliwość zapisywania logów do localStorage
 * - Możliwość eksportu logów
 */
export const LogLevel = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};
const DEFAULT_CONFIG = {
    globalLevel: LogLevel.INFO,
    moduleSettings: {},
    useColors: true,
    saveToStorage: false,
    maxStoredLogs: 1000,
    timestampFormat: 'HH:mm:ss',
    storageKey: 'layerforge_logs'
};
const COLORS = {
    [LogLevel.DEBUG]: '#9e9e9e',
    [LogLevel.INFO]: '#2196f3',
    [LogLevel.WARN]: '#ff9800',
    [LogLevel.ERROR]: '#f44336',
};
const LEVEL_NAMES = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
};

class Logger {
    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.logs = [];
        this.enabled = true;
        this.loadConfig();
    }

    /**
     * Konfiguracja loggera
     * @param {Object} config - Obiekt konfiguracyjny
     */
    configure(config) {
        this.config = { ...this.config, ...config };
        this.saveConfig();
        return this;
    }

    /**
     * Włącz/wyłącz logger globalnie
     * @param {boolean} enabled - Czy logger ma być włączony
     */
    setEnabled(enabled) {
        this.enabled = enabled;
        return this;
    }

    /**
     * Ustaw globalny poziom logowania
     * @param {LogLevel} level - Poziom logowania
     */
    setGlobalLevel(level) {
        this.config.globalLevel = level;
        this.saveConfig();
        return this;
    }

    /**
     * Ustaw poziom logowania dla konkretnego modułu
     * @param {string} module - Nazwa modułu
     * @param {LogLevel} level - Poziom logowania
     */
    setModuleLevel(module, level) {
        this.config.moduleSettings[module] = level;
        this.saveConfig();
        return this;
    }

    /**
     * Sprawdź, czy dany poziom logowania jest aktywny dla modułu
     * @param {string} module - Nazwa modułu
     * @param {LogLevel} level - Poziom logowania do sprawdzenia
     * @returns {boolean} - Czy poziom jest aktywny
     */
    isLevelEnabled(module, level) {
        if (!this.enabled) return false;
        if (this.config.moduleSettings[module] !== undefined) {
            return level >= this.config.moduleSettings[module];
        }
        return level >= this.config.globalLevel;
    }

    /**
     * Formatuj znacznik czasu
     * @returns {string} - Sformatowany znacznik czasu
     */
    formatTimestamp() {
        const now = new Date();
        const format = this.config.timestampFormat;
        return format
            .replace('HH', String(now.getHours()).padStart(2, '0'))
            .replace('mm', String(now.getMinutes()).padStart(2, '0'))
            .replace('ss', String(now.getSeconds()).padStart(2, '0'))
            .replace('SSS', String(now.getMilliseconds()).padStart(3, '0'));
    }

    /**
     * Zapisz log
     * @param {string} module - Nazwa modułu
     * @param {LogLevel} level - Poziom logowania
     * @param {Array} args - Argumenty do zalogowania
     */
    log(module, level, ...args) {
        if (!this.isLevelEnabled(module, level)) return;

        const timestamp = this.formatTimestamp();
        const levelName = LEVEL_NAMES[level];
        const logData = {
            timestamp,
            module,
            level,
            levelName,
            args,
            time: new Date()
        };
        if (this.config.saveToStorage) {
            this.logs.push(logData);
            if (this.logs.length > this.config.maxStoredLogs) {
                this.logs.shift();
            }
            this.saveLogs();
        }
        this.printToConsole(logData);
    }

    /**
     * Wyświetl log w konsoli
     * @param {Object} logData - Dane logu
     */
    printToConsole(logData) {
        const { timestamp, module, level, levelName, args } = logData;
        const prefix = `[${timestamp}] [${module}] [${levelName}]`;
        if (this.config.useColors && typeof console.log === 'function') {
            const color = COLORS[level] || '#000000';
            console.log(`%c${prefix}`, `color: ${color}; font-weight: bold;`, ...args);
            return;
        }
        console.log(prefix, ...args);
    }

    /**
     * Zapisz logi do localStorage
     */
    saveLogs() {
        if (typeof localStorage !== 'undefined' && this.config.saveToStorage) {
            try {
                const simplifiedLogs = this.logs.map(log => ({
                    t: log.timestamp,
                    m: log.module,
                    l: log.level,
                    a: log.args.map(arg => {
                        if (typeof arg === 'object') {
                            try {
                                return JSON.stringify(arg);
                            } catch (e) {
                                return String(arg);
                            }
                        }
                        return arg;
                    })
                }));
                
                localStorage.setItem(this.config.storageKey, JSON.stringify(simplifiedLogs));
            } catch (e) {
                console.error('Failed to save logs to localStorage:', e);
            }
        }
    }

    /**
     * Załaduj logi z localStorage
     */
    loadLogs() {
        if (typeof localStorage !== 'undefined' && this.config.saveToStorage) {
            try {
                const storedLogs = localStorage.getItem(this.config.storageKey);
                if (storedLogs) {
                    this.logs = JSON.parse(storedLogs);
                }
            } catch (e) {
                console.error('Failed to load logs from localStorage:', e);
            }
        }
    }

    /**
     * Zapisz konfigurację do localStorage
     */
    saveConfig() {
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem('layerforge_logger_config', JSON.stringify(this.config));
            } catch (e) {
                console.error('Failed to save logger config to localStorage:', e);
            }
        }
    }

    /**
     * Załaduj konfigurację z localStorage
     */
    loadConfig() {
        if (typeof localStorage !== 'undefined') {
            try {
                const storedConfig = localStorage.getItem('layerforge_logger_config');
                if (storedConfig) {
                    this.config = { ...this.config, ...JSON.parse(storedConfig) };
                }
            } catch (e) {
                console.error('Failed to load logger config from localStorage:', e);
            }
        }
    }

    /**
     * Wyczyść wszystkie logi
     */
    clearLogs() {
        this.logs = [];
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(this.config.storageKey);
        }
        return this;
    }

    /**
     * Eksportuj logi do pliku
     * @param {string} format - Format eksportu ('json' lub 'txt')
     */
    exportLogs(format = 'json') {
        if (this.logs.length === 0) {
            console.warn('No logs to export');
            return;
        }
        
        let content;
        let mimeType;
        let extension;
        
        if (format === 'json') {
            content = JSON.stringify(this.logs, null, 2);
            mimeType = 'application/json';
            extension = 'json';
        } else {
            content = this.logs.map(log => 
                `[${log.timestamp}] [${log.module}] [${log.levelName}] ${log.args.join(' ')}`
            ).join('\n');
            mimeType = 'text/plain';
            extension = 'txt';
        }
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `layerforge_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    /**
     * Log na poziomie DEBUG
     * @param {string} module - Nazwa modułu
     * @param {...any} args - Argumenty do zalogowania
     */
    debug(module, ...args) {
        this.log(module, LogLevel.DEBUG, ...args);
    }

    /**
     * Log na poziomie INFO
     * @param {string} module - Nazwa modułu
     * @param {...any} args - Argumenty do zalogowania
     */
    info(module, ...args) {
        this.log(module, LogLevel.INFO, ...args);
    }

    /**
     * Log na poziomie WARN
     * @param {string} module - Nazwa modułu
     * @param {...any} args - Argumenty do zalogowania
     */
    warn(module, ...args) {
        this.log(module, LogLevel.WARN, ...args);
    }

    /**
     * Log na poziomie ERROR
     * @param {string} module - Nazwa modułu
     * @param {...any} args - Argumenty do zalogowania
     */
    error(module, ...args) {
        this.log(module, LogLevel.ERROR, ...args);
    }
}
export const logger = new Logger();
export const debug = (module, ...args) => logger.debug(module, ...args);
export const info = (module, ...args) => logger.info(module, ...args);
export const warn = (module, ...args) => logger.warn(module, ...args);
export const error = (module, ...args) => logger.error(module, ...args);
if (typeof window !== 'undefined') {
    window.LayerForgeLogger = logger;
}

export default logger;