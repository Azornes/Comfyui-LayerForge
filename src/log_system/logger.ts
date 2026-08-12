/**
author: Azornes
title: AzLogs
version: 1.5.6
description: Logging Setup - Central logging system

Features:
logger - Central logging system
- Multiple log levels (DEBUG, INFO, WARN, ERROR)
- Ability to enable/disable logging globally or per module
- Colorful logs in the console
- Ability to save logs to localStorage
- Ability to export logs
*/

import { DEFAULT_LOGGER_NAME, LOG_LEVEL, LOG_MODULE_NAME, USE_COLORS } from './config.js';

export type LogLevels = (typeof LogLevel)[keyof typeof LogLevel];

export interface LoggerConfig {
    enabled: boolean;
    globalLevel: LogLevels;
    moduleSettings: Record<string, LogLevels>;
    useColors: boolean;
    saveToStorage: boolean;
    maxStoredLogs: number;
    timestampFormat: string;
    includeMilliseconds: boolean;
    compactCallsite: boolean;
    storageKey: string;
}

export interface Callsite {
    url: string;
    line: string;
    column: string;
    full: string;
    label: string;
}

export interface LogData {
    timestamp: string;
    module: string;
    level: LogLevels;
    levelName: string;
    args: any[];
    callsite: Callsite | string;
    time: Date | string;
}

interface ParsedJsonPayload {
    prefix: string;
    value: unknown;
}

type CallsiteInput = string | Partial<Callsite> | null | undefined;

interface StyledConsoleArgs {
    levelName: string;
    timestamp: string;
    root: string;
    args?: unknown[];
    suffix?: string;
    color: string;
}

function padStart(str: string, targetLength: number, padString: string): string {
    targetLength = targetLength >> 0;
    padString = String(padString || ' ');
    if (str.length > targetLength) {
        return String(str);
    }
    else {
        targetLength = targetLength - str.length;
        if (targetLength > padString.length) {
            padString += padString.repeat(targetLength / padString.length);
        }
        return padString.slice(0, targetLength) + String(str);
    }
}
function sanitizeKeyPart(value: string): string {
    return String(value).replace(/[^a-zA-Z0-9_-]+/g, '_');
}
function toPascalCase(value: string): string {
    return String(value)
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('');
}
const LOGGER_NAME = LOG_MODULE_NAME || DEFAULT_LOGGER_NAME;
const STORAGE_PREFIX = sanitizeKeyPart(LOGGER_NAME);
const LOGGER_CONFIG_KEY = `${STORAGE_PREFIX}_logger_config`;
const LOGGER_STORAGE_KEY = `${STORAGE_PREFIX}_logs`;
const LOGGER_EXPORT_PREFIX = STORAGE_PREFIX;
const WINDOW_LOGGER_KEY = `${toPascalCase(LOGGER_NAME)}Logger`;
export const LogLevel = {
    DEBUG: 10,
    INFO: 20,
    WARN: 30,
    ERROR: 40,
    FATAL: 50,
    NONE: 100
} as const;
const DEFAULT_CONFIG: LoggerConfig = {
    enabled: true,
    globalLevel: LogLevel[LOG_LEVEL] ?? LogLevel.INFO,
    moduleSettings: {},
    useColors: USE_COLORS,
    saveToStorage: false,
    maxStoredLogs: 1000,
    timestampFormat: 'HH:mm:ss',
    includeMilliseconds: true,
    compactCallsite: true,
    storageKey: LOGGER_STORAGE_KEY
};
const COLORS: Record<number, string> = {
    [LogLevel.DEBUG]: '#9B59B6',
    [LogLevel.INFO]: '#2ECC71',
    [LogLevel.WARN]: '#F39C12',
    [LogLevel.ERROR]: '#C0392B',
    [LogLevel.FATAL]: '#E74C3C',
};
const LEVEL_NAMES: Record<number, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]: 'INFO',
    [LogLevel.WARN]: 'WARN',
    [LogLevel.ERROR]: 'ERROR',
    [LogLevel.FATAL]: 'FATAL',
};
const CONSOLE_METHODS: Record<number, keyof Console> = {
    [LogLevel.DEBUG]: 'debug',
    [LogLevel.INFO]: 'info',
    [LogLevel.WARN]: 'warn',
    [LogLevel.ERROR]: 'error',
    [LogLevel.FATAL]: 'error',
};
const TIME_BG = '#263f4c';
const LEVEL_WIDTH = 5;

export class Logger {
    public config: LoggerConfig;
    public logs: LogData[];
    public enabled: boolean;

    constructor() {
        this.config = { ...DEFAULT_CONFIG };
        this.logs = [];
        this.enabled = true;
        this.loadConfig();
        this.enabled = this.config.enabled !== false;
        this.loadLogs();
    }
    /**
     * Configure the logger
     * @param {Partial<LoggerConfig>} config - Configuration object
     */
    configure(config: Partial<LoggerConfig>): this {
        this.config = { ...this.config, ...config };
        if (Object.prototype.hasOwnProperty.call(config, 'enabled')) {
            this.enabled = config.enabled !== false;
        }
        this.config.globalLevel = this.normalizeLevel(this.config.globalLevel, DEFAULT_CONFIG.globalLevel);
        if (!this.config.moduleSettings || typeof this.config.moduleSettings !== 'object') {
            this.config.moduleSettings = {};
        } else {
            Object.entries(this.config.moduleSettings).forEach(([module, level]) => {
                this.config.moduleSettings[module] = this.normalizeLevel(level, this.config.globalLevel);
            });
        }
        this.saveConfig();
        return this;
    }
    /**
     * Enable/disable logger globally
     * @param {boolean} enabled - Whether the logger should be enabled
     */
    setEnabled(enabled: boolean): this {
        this.enabled = Boolean(enabled);
        this.config.enabled = this.enabled;
        this.saveConfig();
        return this;
    }
    /**
     * Set global logging level
     * @param {LogLevels} level - Logging level
     */
    setGlobalLevel(level: unknown): this {
        this.config.globalLevel = this.normalizeLevel(level, DEFAULT_CONFIG.globalLevel);
        this.saveConfig();
        return this;
    }
    normalizeLevel(level: unknown, fallback: LogLevels = this.config.globalLevel): LogLevels {
        if (typeof level === 'number' && Object.values(LogLevel).includes(level as LogLevels)) {
            return level as LogLevels;
        }
        if (typeof level === 'string') {
            let normalized = level.trim().toUpperCase();
            if (normalized === 'WARNING') normalized = 'WARN';
            if (normalized === 'CRITICAL') normalized = 'FATAL';
            if (Object.prototype.hasOwnProperty.call(LogLevel, normalized)) {
                return LogLevel[normalized as keyof typeof LogLevel];
            }
        }
        return fallback;
    }
    getLevelName(level: unknown = this.config.globalLevel): string {
        const normalizedLevel = this.normalizeLevel(level, this.config.globalLevel);
        return Object.entries(LogLevel).find(([, value]) => value === normalizedLevel)?.[0] || 'INFO';
    }
    setGlobalAndModuleLevel(level: unknown): this {
        const normalizedLevel = this.normalizeLevel(level, this.config.globalLevel);
        this.config.globalLevel = normalizedLevel;
        Object.keys(this.config.moduleSettings || {}).forEach((module) => {
            this.config.moduleSettings[module] = normalizedLevel;
        });
        this.saveConfig();
        return this;
    }
    /**
     * Set logging level for a specific module
     * @param {string} module - Module name
     * @param {LogLevels} level - Logging level
     */
    setModuleLevel(module: string, level: unknown): this {
        this.config.moduleSettings[module] = this.normalizeLevel(level, this.config.globalLevel);
        this.saveConfig();
        return this;
    }
    /**
     * Check if a given logging level is active for a module
     * @param {string} module - Module name
     * @param {LogLevels} level - Logging level to check
     * @returns {boolean} - Whether the level is active
     */
    isLevelEnabled(module: string, level: LogLevels): boolean {
        if (!this.enabled)
            return false;
        if (this.config.moduleSettings[module] !== undefined) {
            return level >= this.config.moduleSettings[module];
        }
        return level >= this.config.globalLevel;
    }
    /**
     * Format timestamp
     * @returns {string} - Formatted timestamp
     */
    formatTimestamp(): string {
        const now = new Date();
        const format = this.config.timestampFormat || DEFAULT_CONFIG.timestampFormat;
        const milliseconds = padStart(String(now.getMilliseconds()), 3, '0');
        const timestamp = format
            .replace('HH', padStart(String(now.getHours()), 2, '0'))
            .replace('mm', padStart(String(now.getMinutes()), 2, '0'))
            .replace('ss', padStart(String(now.getSeconds()), 2, '0'))
            .replace('SSS', milliseconds);
        if (this.config.includeMilliseconds !== false && !format.includes('SSS')) {
            return `${timestamp}.${milliseconds}`;
        }
        return timestamp;
    }
    /**
     * Save log
     * @param {string} module - Module name
     * @param {LogLevels} level - Logging level
     * @param {any[]} args - Arguments to log
     */
    log(module: string, level: LogLevels, ...args: any[]): void {
        if (!this.isLevelEnabled(module, level))
            return;
        const timestamp = this.formatTimestamp();
        const levelName = LEVEL_NAMES[level];
        const callsite = this.getCallsite();
        const logData = {
            timestamp,
            module,
            level,
            levelName,
            args,
            callsite,
            time: new Date()
        };
        this.logs.push(logData);
        if (this.logs.length > this.config.maxStoredLogs) {
            this.logs.shift();
        }
        if (this.config.saveToStorage) {
            this.saveLogs();
        }
        this.printToConsole(logData);
    }
    /**
     * Display log to console
     * @param {LogData} logData - Log data
     */
    printToConsole(logData: LogData): void {
        const { timestamp, module, level, levelName, args, callsite } = logData;
        const consoleMethod = CONSOLE_METHODS[level] || 'log';
        const consoleRecord = console as unknown as Record<string, (...args: any[]) => void>;
        const consoleFn = typeof consoleRecord[consoleMethod] === 'function'
            ? consoleRecord[consoleMethod].bind(console)
            : console.log.bind(console);
        const detailFn = typeof console.log === 'function'
            ? console.log.bind(console)
            : consoleFn;
        const normalizedCallsite = this.normalizeCallsite(callsite);
        const shouldGroupDetails = this.shouldGroupDetails(normalizedCallsite);
        const outputFn = shouldGroupDetails
            ? console.groupCollapsed.bind(console)
            : consoleFn;
        const { root, detail } = this.splitModuleName(module);
        const consoleArgs = this.formatConsoleArgs(args);
        const suffix = this.formatSuffix(detail, normalizedCallsite);
        const suffixArgs = suffix ? [suffix.trimStart()] : [];
        if (this.config.useColors && typeof consoleFn === 'function') {
            const color = COLORS[level] || '#000000';
            outputFn(...this.formatStyledConsoleArgs({
                levelName,
                timestamp,
                root,
                args: consoleArgs,
                suffix: suffixArgs[0] || '',
                color
            }));
            this.printExpandedDetails(detailFn, normalizedCallsite);
            return;
        }
        outputFn(`${levelName.padEnd(LEVEL_WIDTH, ' ')} ${timestamp} ${root}`, ...consoleArgs, ...suffixArgs);
        this.printExpandedDetails(detailFn, normalizedCallsite);
    }

    splitModuleName(module: string): { root: string; detail: string } {
        const value = String(module || LOGGER_NAME);
        const parts = value.split('.');
        if (parts.length === 1 && value !== LOGGER_NAME) {
            return {
                root: LOGGER_NAME,
                detail: value
            };
        }
        const root = parts.shift() || LOGGER_NAME;
        return {
            root,
            detail: parts.join('.')
        };
    }

    stringifyArgs(args: unknown[] = []): string {
        return args.map((arg) => {
            if (typeof arg === 'string') {
                return arg;
            }
            if (arg instanceof Error) {
                return arg.stack || arg.message;
            }
            if (typeof arg === 'object' && arg !== null) {
                try {
                    return JSON.stringify(arg);
                }
                catch (_e) {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');
    }

    formatConsoleArgs(args: unknown[] = []): unknown[] {
        return args.flatMap((arg) => this.formatConsoleArg(arg));
    }

    formatConsoleArg(arg: unknown): unknown[] {
        if (typeof arg === 'string') {
            const payload = this.parseJsonPayloadFromString(arg);
            if (payload) {
                return payload.prefix ? [payload.prefix, payload.value] : [payload.value];
            }
        }
        return [arg];
    }

    formatStyledConsoleArgs({ levelName, timestamp, root, args = [], suffix = '', color }: StyledConsoleArgs): any[] {
        const outputArgs: any[] = [
            `%c ${levelName.padEnd(LEVEL_WIDTH, ' ')} %c ${timestamp} %c %c ${root} %c %c `,
            `background:${color};color:#fff;font-weight:bold;`,
            `background:${TIME_BG};color:#fff;font-weight:bold;`,
            `background:${color};color:${color};`,
            `background:${TIME_BG};color:#fff;font-weight:bold;`,
            `background:${color};color:${color};`,
            `color:${color};font-weight:bold;`
        ];

        let format = outputArgs[0];
        let hasContent = false;
        args.forEach((arg) => {
            if (hasContent) {
                format += ' ';
            }
            if (this.isExpandableConsoleArg(arg)) {
                format += '%o';
                outputArgs.push(arg);
            }
            else {
                format += this.escapeConsoleFormat(String(this.stringifyConsolePrimitive(arg)));
            }
            hasContent = true;
        });

        if (suffix) {
            if (hasContent) {
                format += ' ';
            }
            format += `%c${this.escapeConsoleFormat(suffix)}`;
            outputArgs.push('');
        }

        outputArgs[0] = format;
        return outputArgs;
    }

    isExpandableConsoleArg(arg: unknown): boolean {
        return (typeof arg === 'object' && arg !== null && !(arg instanceof Error))
            || typeof arg === 'function';
    }

    stringifyConsolePrimitive(arg: unknown): string {
        if (arg instanceof Error) {
            return arg.stack || arg.message;
        }
        return String(arg);
    }

    escapeConsoleFormat(value: string): string {
        return String(value).replace(/%/g, '%%');
    }

    getCallsite(): Callsite | '' {
        const stack = new Error().stack;
        if (!stack) {
            return '';
        }

        const lines = stack.split('\n').slice(1);
        for (const line of lines) {
            const parsed = this.parseStackLine(line);
            if (!parsed) {
                continue;
            }

            const normalizedUrl = parsed.url.replace(/\\/g, '/');
            if (normalizedUrl.includes('/log_system/')) {
                continue;
            }

            return this.createCallsite(parsed);
        }

        return '';
    }

    parseStackLine(line: string): Pick<Callsite, 'url' | 'line' | 'column'> | null {
        const match = String(line).trim().match(/(?:at\s+(?:.+?\s+\()?)?(.+?\.(?:mjs|js|tsx?|jsx)(?:[?#][^:)]*)?):(\d+):(\d+)\)?$/);
        if (!match) {
            return null;
        }

        const source = match[1];
        const atIndex = source.lastIndexOf('@');
        return {
            url: atIndex >= 0 ? source.slice(atIndex + 1) : source,
            line: match[2],
            column: match[3],
        };
    }

    formatCallsite(callsite: CallsiteInput): string {
        if (!callsite) {
            return '';
        }
        if (typeof callsite === 'string') {
            return callsite;
        }
        if (callsite.full) {
            return callsite.full;
        }
        return `${callsite.url}:${callsite.line}:${callsite.column}`;
    }

    createCallsite(callsite: Pick<Callsite, 'url' | 'line' | 'column'>): Callsite {
        const full = this.formatCallsite(callsite);
        return {
            url: callsite.url,
            line: callsite.line,
            column: callsite.column,
            full,
            label: this.formatCompactCallsite(callsite)
        };
    }

    normalizeCallsite(callsite: CallsiteInput): Callsite | null {
        if (!callsite) {
            return null;
        }
        const full = this.formatCallsite(callsite);
        if (!full) {
            return null;
        }
        const objectCallsite = typeof callsite === 'object' && callsite !== null ? callsite : {};
        return {
            url: objectCallsite.url || '',
            line: objectCallsite.line || '',
            column: objectCallsite.column || '',
            full,
            label: objectCallsite.label || this.formatCompactCallsite(callsite),
        };
    }

    formatCompactCallsite(callsite: CallsiteInput): string {
        const source = typeof callsite === 'string'
            ? callsite.replace(/:\d+:\d+$/, '')
            : callsite?.url || callsite?.full || '';
        const normalizedSource = String(source).split(/[?#]/)[0].replace(/\\/g, '/');
        const filename = normalizedSource.slice(normalizedSource.lastIndexOf('/') + 1);
        return filename.replace(/\.(?:mjs|js|tsx?|jsx)$/i, '') || this.formatCallsite(callsite);
    }

    shouldGroupDetails(callsite: Callsite | null): boolean {
        return this.config.compactCallsite !== false
            && !!callsite?.full
            && typeof console.groupCollapsed === 'function'
            && typeof console.groupEnd === 'function';
    }

    printExpandedDetails(consoleFn: (...args: any[]) => void, callsite: Callsite | null): void {
        if (!this.shouldGroupDetails(callsite)) {
            return;
        }
        if (callsite?.full) {
            consoleFn(`Source: ${callsite.full}`);
        }
        console.groupEnd();
    }

    parseJsonPayloadFromString(value: string): ParsedJsonPayload | null {
        const parsed = this.parseJsonLikeString(value);
        if (parsed !== null) {
            return {
                prefix: '',
                value: parsed
            };
        }
        const start = this.findJsonPayloadStart(value);
        if (start <= 0) {
            return null;
        }
        const payload = this.parseJsonLikeString(value.slice(start));
        if (payload === null) {
            return null;
        }
        return {
            prefix: value.slice(0, start).trimEnd(),
            value: payload
        };
    }

    findJsonPayloadStart(value: string): number {
        const objectStart = value.indexOf('{');
        const arrayStart = value.indexOf('[');
        if (objectStart < 0) {
            return arrayStart;
        }
        if (arrayStart < 0) {
            return objectStart;
        }
        return Math.min(objectStart, arrayStart);
    }

    parseJsonLikeString(value: string): unknown | null {
        const trimmed = value.trim();
        if (!trimmed || !/^[{[]/.test(trimmed)) {
            return null;
        }
        try {
            return JSON.parse(trimmed);
        }
        catch (_e) {
            return null;
        }
    }

    formatSuffix(detail: string, callsite: CallsiteInput, options: { compactCallsite?: boolean } = {}): string {
        const normalizedCallsite = this.normalizeCallsite(callsite);
        const compactCallsite = options.compactCallsite ?? this.config.compactCallsite !== false;
        const suffixDetail = normalizedCallsite
            ? (compactCallsite ? normalizedCallsite.label : normalizedCallsite.full)
            : detail;
        return suffixDetail ? ` (${suffixDetail})` : '';
    }

    serializeLogEntry(log: LogData): Record<string, unknown> {
        return {
            timestamp: log.timestamp,
            module: log.module,
            level: log.level,
            levelName: log.levelName,
            args: log.args.map((arg) => {
                if (typeof arg === 'object' && arg !== null) {
                    try {
                        return JSON.parse(JSON.stringify(arg));
                    }
                    catch (_e) {
                        return String(arg);
                    }
                }
                return arg;
            }),
            callsite: log.callsite || '',
            time: log.time instanceof Date ? log.time.toISOString() : log.time
        };
    }
    deserializeLogEntry(log: unknown): LogData | null {
        if (!log || typeof log !== 'object') {
            return null;
        }
        const value = log as Record<string, any>;
        if ('timestamp' in value && 'module' in value && 'level' in value) {
            return {
                timestamp: String(value.timestamp),
                module: String(value.module),
                level: this.normalizeLevel(value.level, LogLevel.INFO),
                levelName: value.levelName || LEVEL_NAMES[value.level] || 'INFO',
                args: Array.isArray(value.args) ? value.args : [],
                callsite: value.callsite || '',
                time: value.time ? new Date(value.time) : new Date()
            };
        }
        if ('t' in value && 'm' in value && 'l' in value) {
            return {
                timestamp: String(value.t),
                module: String(value.m),
                level: this.normalizeLevel(value.l, LogLevel.INFO),
                levelName: LEVEL_NAMES[value.l] || 'INFO',
                args: Array.isArray(value.a) ? value.a : [],
                callsite: value.c || '',
                time: new Date()
            };
        }
        return null;
    }
    /**
     * Save logs to localStorage
     */
    saveLogs(): void {
        if (typeof localStorage !== 'undefined' && this.config.saveToStorage) {
            try {
                const storedLogs = this.logs.map((log) => this.serializeLogEntry(log));
                localStorage.setItem(this.config.storageKey, JSON.stringify(storedLogs));
            }
            catch (e) {
                console.error('Failed to save logs to localStorage:', e);
            }
        }
    }
    /**
     * Load logs from localStorage
     */
    loadLogs(): void {
        if (typeof localStorage !== 'undefined' && this.config.saveToStorage) {
            try {
                const storedLogs = localStorage.getItem(this.config.storageKey);
                if (storedLogs) {
                    this.logs = JSON.parse(storedLogs)
                        .map((log: unknown) => this.deserializeLogEntry(log))
                        .filter((log: LogData | null): log is LogData => Boolean(log));
                }
            }
            catch (e) {
                console.error('Failed to load logs from localStorage:', e);
            }
        }
    }
    /**
     * Save configuration to localStorage
     */
    saveConfig(): void {
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem(LOGGER_CONFIG_KEY, JSON.stringify(this.config));
            }
            catch (e) {
                console.error('Failed to save logger config to localStorage:', e);
            }
        }
    }
    /**
     * Load configuration from localStorage
     */
    loadConfig(): void {
        if (typeof localStorage !== 'undefined') {
            try {
                const storedConfig = localStorage.getItem(LOGGER_CONFIG_KEY);
                if (storedConfig) {
                    this.config = { ...this.config, ...JSON.parse(storedConfig) };
                    this.configure(this.config);
                }
            }
            catch (e) {
                console.error('Failed to load logger config from localStorage:', e);
            }
        }
    }
    /**
     * Clear all logs
     */
    clearLogs(): this {
        this.logs = [];
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(this.config.storageKey);
        }
        return this;
    }
    /**
     * Export logs to file
     * @param {'json' | 'txt'} format - Export format
     */
    exportLogs(format: 'json' | 'txt' = 'json'): boolean {
        if (this.logs.length === 0) {
            console.warn('No logs to export');
            return false;
        }
        let content;
        let mimeType;
        let extension;
        if (format === 'json') {
            content = JSON.stringify(this.logs.map((log) => this.serializeLogEntry(log)), null, 2);
            mimeType = 'application/json';
            extension = 'json';
        }
        else {
            content = this.logs.map((log) => {
                const { root, detail } = this.splitModuleName(log.module);
                const suffix = this.formatSuffix(detail, log.callsite, { compactCallsite: false });
                return `${log.levelName.padEnd(LEVEL_WIDTH, ' ')} ${log.timestamp} ${root} ${this.stringifyArgs(log.args)}${suffix}`;
            }).join('\n');
            mimeType = 'text/plain';
            extension = 'txt';
        }
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${LOGGER_EXPORT_PREFIX}_logs_${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return true;
    }
    /**
     * Log at DEBUG level
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    debug(module: string, ...args: any[]): void {
        this.log(module, LogLevel.DEBUG, ...args);
    }
    /**
     * Log at INFO level
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    info(module: string, ...args: any[]): void {
        this.log(module, LogLevel.INFO, ...args);
    }
    /**
     * Log at WARN level
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    warn(module: string, ...args: any[]): void {
        this.log(module, LogLevel.WARN, ...args);
    }
    /**
     * Log at ERROR level
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    error(module: string, ...args: any[]): void {
        this.log(module, LogLevel.ERROR, ...args);
    }
    /**
     * Log at ERROR level with exception stack trace
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    exception(module: string, ...args: any[]): void {
        const hasError = args.some(arg => arg instanceof Error);
        if (!hasError) {
            args.push(new Error("Captured stack trace"));
        }
        this.log(module, LogLevel.ERROR, ...args);
    }
    /**
     * Log at FATAL level
     * @param {string} module - Module name
     * @param {any[]} args - Arguments to log
     */
    fatal(module: string, ...args: any[]): void {
        this.log(module, LogLevel.FATAL, ...args);
    }
}
export const logger = new Logger();
export const debug = (module: string, ...args: any[]): void => logger.debug(module, ...args);
export const info = (module: string, ...args: any[]): void => logger.info(module, ...args);
export const warn = (module: string, ...args: any[]): void => logger.warn(module, ...args);
export const error = (module: string, ...args: any[]): void => logger.error(module, ...args);
export const exception = (module: string, ...args: any[]): void => logger.exception(module, ...args);
export const fatal = (module: string, ...args: any[]): void => logger.fatal(module, ...args);
if (typeof window !== 'undefined') {
    (window as unknown as Window & Record<string, unknown>)[WINDOW_LOGGER_KEY] = logger;
}
export default logger;
