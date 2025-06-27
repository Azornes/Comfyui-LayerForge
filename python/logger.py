"""
Logger - Centralny system logowania dla ComfyUI-LayerForge (Python)

Funkcje:
- Różne poziomy logowania (DEBUG, INFO, WARN, ERROR)
- Możliwość włączania/wyłączania logów globalnie lub per moduł
- Kolorowe logi w konsoli
- Rotacja plików logów
- Konfiguracja przez zmienne środowiskowe
"""

import os
import sys
import json
import logging
import datetime
from enum import IntEnum
from logging.handlers import RotatingFileHandler
import traceback

# Poziomy logowania
class LogLevel(IntEnum):
    DEBUG = 10
    INFO = 20
    WARN = 30
    ERROR = 40
    NONE = 100

# Mapowanie poziomów logowania
LEVEL_MAP = {
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.WARN: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
    LogLevel.NONE: logging.CRITICAL + 1
}

# Kolory ANSI dla różnych poziomów logowania
COLORS = {
    LogLevel.DEBUG: '\033[90m',  # Szary
    LogLevel.INFO: '\033[94m',   # Niebieski
    LogLevel.WARN: '\033[93m',   # Żółty
    LogLevel.ERROR: '\033[91m',  # Czerwony
    'RESET': '\033[0m'           # Reset
}

# Konfiguracja domyślna
DEFAULT_CONFIG = {
    'global_level': LogLevel.INFO,
    'module_settings': {},
    'use_colors': True,
    'log_to_file': False,
    'log_dir': 'logs',
    'max_file_size_mb': 10,
    'backup_count': 5,
    'timestamp_format': '%H:%M:%S',
}

class ColoredFormatter(logging.Formatter):
    """Formatter dodający kolory do logów w konsoli"""
    
    def __init__(self, fmt=None, datefmt=None, use_colors=True):
        super().__init__(fmt, datefmt)
        self.use_colors = use_colors
    
    def format(self, record):
        # Get the formatted message from the record
        message = record.getMessage()
        if record.exc_info:
            message += "\n" + self.formatException(record.exc_info)

        levelname = record.levelname
        
        # Build the log prefix
        prefix = '[{}] [{}] [{}]'.format(
            self.formatTime(record, self.datefmt),
            record.name,
            record.levelname
        )

        # Apply color and bold styling to the prefix
        if self.use_colors and hasattr(LogLevel, levelname):
            level_enum = getattr(LogLevel, levelname)
            if level_enum in COLORS:
                # Apply bold (\033[1m) and color, then reset
                prefix = f"\033[1m{COLORS[level_enum]}{prefix}{COLORS['RESET']}"

        return f"{prefix} {message}"

class LayerForgeLogger:
    """Główna klasa loggera dla LayerForge"""
    
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(LayerForgeLogger, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
            
        self.config = DEFAULT_CONFIG.copy()
        self.enabled = True
        self.loggers = {}
        
        # Załaduj konfigurację ze zmiennych środowiskowych
        self._load_config_from_env()
        
        self._initialized = True
    
    def _load_config_from_env(self):
        """Załaduj konfigurację ze zmiennych środowiskowych"""
        
        # Poziom globalny
        if 'LAYERFORGE_LOG_LEVEL' in os.environ:
            level_name = os.environ['LAYERFORGE_LOG_LEVEL'].upper()
            if hasattr(LogLevel, level_name):
                self.config['global_level'] = getattr(LogLevel, level_name)
        
        # Ustawienia modułów
        if 'LAYERFORGE_MODULE_LEVELS' in os.environ:
            try:
                module_settings = json.loads(os.environ['LAYERFORGE_MODULE_LEVELS'])
                for module, level_name in module_settings.items():
                    if hasattr(LogLevel, level_name.upper()):
                        self.config['module_settings'][module] = getattr(LogLevel, level_name.upper())
            except json.JSONDecodeError:
                pass
        
        # Inne ustawienia
        if 'LAYERFORGE_USE_COLORS' in os.environ:
            self.config['use_colors'] = os.environ['LAYERFORGE_USE_COLORS'].lower() == 'true'
        
        if 'LAYERFORGE_LOG_TO_FILE' in os.environ:
            self.config['log_to_file'] = os.environ['LAYERFORGE_LOG_TO_FILE'].lower() == 'true'
        
        if 'LAYERFORGE_LOG_DIR' in os.environ:
            self.config['log_dir'] = os.environ['LAYERFORGE_LOG_DIR']
        
        if 'LAYERFORGE_MAX_FILE_SIZE_MB' in os.environ:
            try:
                self.config['max_file_size_mb'] = int(os.environ['LAYERFORGE_MAX_FILE_SIZE_MB'])
            except ValueError:
                pass
        
        if 'LAYERFORGE_BACKUP_COUNT' in os.environ:
            try:
                self.config['backup_count'] = int(os.environ['LAYERFORGE_BACKUP_COUNT'])
            except ValueError:
                pass
    
    def configure(self, config):
        """Konfiguracja loggera"""
        self.config.update(config)
        
        # Jeśli włączono logowanie do pliku, upewnij się, że katalog istnieje
        if self.config.get('log_to_file') and self.config.get('log_dir'):
            try:
                os.makedirs(self.config['log_dir'], exist_ok=True)
            except OSError as e:
                # To jest sytuacja krytyczna, więc użyjmy print
                print(f"[CRITICAL] Could not create log directory: {self.config['log_dir']}. Error: {e}")
                traceback.print_exc()
                # Wyłącz logowanie do pliku, aby uniknąć dalszych błędów
                self.config['log_to_file'] = False

        return self
    
    def set_enabled(self, enabled):
        """Włącz/wyłącz logger globalnie"""
        self.enabled = enabled
        return self
    
    def set_global_level(self, level):
        """Ustaw globalny poziom logowania"""
        self.config['global_level'] = level
        return self
    
    def set_module_level(self, module, level):
        """Ustaw poziom logowania dla konkretnego modułu"""
        self.config['module_settings'][module] = level
        return self
    
    def is_level_enabled(self, module, level):
        """Sprawdź, czy dany poziom logowania jest aktywny dla modułu"""
        if not self.enabled:
            return False
        
        # Sprawdź ustawienia modułu, jeśli istnieją
        if module in self.config['module_settings']:
            return level >= self.config['module_settings'][module]
        
        # W przeciwnym razie użyj globalnego poziomu
        return level >= self.config['global_level']
    
    def _get_logger(self, module):
        """Pobierz lub utwórz logger dla modułu"""
        if module in self.loggers:
            return self.loggers[module]
        
        # Utwórz nowy logger
        logger = logging.getLogger(f"layerforge.{module}")
        logger.setLevel(logging.DEBUG)  # Ustaw najniższy poziom, filtrowanie będzie później
        logger.propagate = False
        
        # Dodaj handler dla konsoli
        console_handler = logging.StreamHandler(sys.stdout)
        console_formatter = ColoredFormatter(
            fmt='[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s',
            datefmt=self.config['timestamp_format'],
            use_colors=self.config['use_colors']
        )
        console_handler.setFormatter(console_formatter)
        logger.addHandler(console_handler)
        
        # Dodaj handler dla pliku, jeśli włączono logowanie do pliku
        if self.config['log_to_file']:
            log_file = os.path.join(self.config['log_dir'], f"layerforge_{module}.log")
            file_handler = RotatingFileHandler(
                log_file,
                maxBytes=self.config['max_file_size_mb'] * 1024 * 1024,
                backupCount=self.config['backup_count'],
                encoding='utf-8'
            )
            file_formatter = logging.Formatter(
                fmt='[%(asctime)s] [%(name)s] [%(levelname)s] %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(file_formatter)
            logger.addHandler(file_handler)
        
        self.loggers[module] = logger
        return logger
    
    def log(self, module, level, *args, **kwargs):
        """Zapisz log"""
        if not self.is_level_enabled(module, level):
            return
        
        logger = self._get_logger(module)
        
        # Konwertuj argumenty na string
        message = " ".join(str(arg) for arg in args)
        
        # Dodaj informacje o wyjątku, jeśli podano
        exc_info = kwargs.get('exc_info', None)
        
        # Mapuj poziom LogLevel na poziom logging
        log_level = LEVEL_MAP.get(level, logging.INFO)
        
        # Zapisz log
        logger.log(log_level, message, exc_info=exc_info)
    
    def debug(self, module, *args, **kwargs):
        """Log na poziomie DEBUG"""
        self.log(module, LogLevel.DEBUG, *args, **kwargs)
    
    def info(self, module, *args, **kwargs):
        """Log na poziomie INFO"""
        self.log(module, LogLevel.INFO, *args, **kwargs)
    
    def warn(self, module, *args, **kwargs):
        """Log na poziomie WARN"""
        self.log(module, LogLevel.WARN, *args, **kwargs)
    
    def error(self, module, *args, **kwargs):
        """Log na poziomie ERROR"""
        self.log(module, LogLevel.ERROR, *args, **kwargs)
    
    def exception(self, module, *args):
        """Log wyjątku na poziomie ERROR"""
        self.log(module, LogLevel.ERROR, *args, exc_info=True)

# Singleton
logger = LayerForgeLogger()

# Funkcje pomocnicze
def debug(module, *args, **kwargs):
    """Log na poziomie DEBUG"""
    logger.debug(module, *args, **kwargs)

def info(module, *args, **kwargs):
    """Log na poziomie INFO"""
    logger.info(module, *args, **kwargs)

def warn(module, *args, **kwargs):
    """Log na poziomie WARN"""
    logger.warn(module, *args, **kwargs)

def error(module, *args, **kwargs):
    """Log na poziomie ERROR"""
    logger.error(module, *args, **kwargs)

def exception(module, *args):
    """Log wyjątku na poziomie ERROR"""
    logger.exception(module, *args)

# Funkcja do szybkiego włączania/wyłączania debugowania
def set_debug(enabled=True):
    """Włącz/wyłącz debugowanie globalnie"""
    if enabled:
        logger.set_global_level(LogLevel.DEBUG)
    else:
        logger.set_global_level(LogLevel.INFO)
    return logger

# Funkcja do włączania/wyłączania logowania do pliku
def set_file_logging(enabled=True, log_dir=None):
    """Włącz/wyłącz logowanie do pliku"""
    logger.config['log_to_file'] = enabled
    if log_dir:
        logger.config['log_dir'] = log_dir
        os.makedirs(log_dir, exist_ok=True)
    
    # Zresetuj loggery, aby zastosować nowe ustawienia
    logger.loggers = {}
    return logger
