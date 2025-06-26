# System Logowania dla ComfyUI-LayerForge

Ten dokument opisuje system logowania zaimplementowany dla projektu ComfyUI-LayerForge, który umożliwia łatwe zarządzanie debugowaniem kodu zarówno w części JavaScript, jak i Python.

## Spis treści

1. [Wprowadzenie](#wprowadzenie)
2. [Konfiguracja](#konfiguracja)
3. [Użycie w JavaScript](#użycie-w-javascript)
4. [Użycie w Python](#użycie-w-python)
5. [Poziomy logowania](#poziomy-logowania)
6. [Zarządzanie logami](#zarządzanie-logami)
7. [Przykłady](#przykłady)

## Wprowadzenie

System logowania ComfyUI-LayerForge został zaprojektowany, aby zapewnić:

- Spójne logowanie w całym projekcie (JavaScript i Python)
- Możliwość włączania/wyłączania logów globalnie lub per moduł
- Różne poziomy logowania (DEBUG, INFO, WARN, ERROR)
- Kolorowe logi w konsoli
- Możliwość zapisywania logów do plików
- Eksport logów do analizy

## Konfiguracja

### Konfiguracja JavaScript

```javascript
// Importuj logger
import {logger, LogLevel} from "./logger.js";

// Konfiguracja globalna
logger.configure({
    globalLevel: LogLevel.INFO,  // Domyślny poziom logowania
    useColors: true,             // Kolorowe logi w konsoli
    saveToStorage: true,         // Zapisywanie logów do localStorage
    maxStoredLogs: 1000          // Maksymalna liczba przechowywanych logów
});

// Konfiguracja per moduł
logger.setModuleLevel('Canvas', LogLevel.DEBUG);
logger.setModuleLevel('API', LogLevel.WARN);

// Włączanie/wyłączanie globalnie
logger.setEnabled(true);  // Włącz wszystkie logi
logger.setEnabled(false); // Wyłącz wszystkie logi
```

### Konfiguracja Python

```python
# Importuj logger
from python.logger import logger, LogLevel, set_debug, set_file_logging

# Konfiguracja globalna
logger.configure({
    'global_level': LogLevel.INFO,
    'use_colors': True,
    'log_to_file': True,
    'log_dir': 'logs',
    'max_file_size_mb': 10,
    'backup_count': 5
})

# Konfiguracja per moduł
logger.set_module_level('canvas_node', LogLevel.DEBUG)
logger.set_module_level('api', LogLevel.WARN)

# Szybkie włączanie debugowania
set_debug(True)  # Ustawia globalny poziom na DEBUG
set_debug(False) # Ustawia globalny poziom na INFO

# Włączanie/wyłączanie logowania do pliku
set_file_logging(True, 'custom_logs')
```

### Konfiguracja przez zmienne środowiskowe (Python)

Możesz również skonfigurować logger Python za pomocą zmiennych środowiskowych:

```bash
# Poziom globalny (DEBUG, INFO, WARN, ERROR, NONE)
export LAYERFORGE_LOG_LEVEL=DEBUG

# Ustawienia modułów (format JSON)
export LAYERFORGE_MODULE_LEVELS='{"canvas_node": "DEBUG", "api": "WARN"}'

# Inne ustawienia
export LAYERFORGE_USE_COLORS=true
export LAYERFORGE_LOG_TO_FILE=true
export LAYERFORGE_LOG_DIR=logs
export LAYERFORGE_MAX_FILE_SIZE_MB=10
export LAYERFORGE_BACKUP_COUNT=5
```

## Użycie w JavaScript

### Podstawowe użycie

```javascript
import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu
const log = {
    debug: (...args) => logger.debug('MojModul', ...args),
    info: (...args) => logger.info('MojModul', ...args),
    warn: (...args) => logger.warn('MojModul', ...args),
    error: (...args) => logger.error('MojModul', ...args)
};

// Używanie loggera
log.debug("To jest wiadomość debugowania");
log.info("To jest informacja");
log.warn("To jest ostrzeżenie");
log.error("To jest błąd");

// Logowanie obiektów
log.debug("Dane użytkownika:", { id: 123, name: "Jan Kowalski" });

// Logowanie błędów
try {
    // Kod, który może rzucić wyjątek
} catch (error) {
    log.error("Wystąpił błąd:", error);
}
```

### Dostęp z konsoli przeglądarki

Logger jest dostępny globalnie w przeglądarce jako `window.LayerForgeLogger`, co umożliwia łatwe debugowanie:

```javascript
// W konsoli przeglądarki
LayerForgeLogger.setGlobalLevel(LayerForgeLogger.LogLevel.DEBUG);
LayerForgeLogger.setModuleLevel('Canvas', LayerForgeLogger.LogLevel.DEBUG);
LayerForgeLogger.exportLogs('json'); // Eksportuje logi do pliku JSON
```

## Użycie w Python

### Podstawowe użycie

```python
from python.logger import debug, info, warn, error, exception

# Używanie funkcji pomocniczych
debug('canvas_node', 'To jest wiadomość debugowania')
info('canvas_node', 'To jest informacja')
warn('canvas_node', 'To jest ostrzeżenie')
error('canvas_node', 'To jest błąd')

# Logowanie wyjątków
try:
    # Kod, który może rzucić wyjątek
except Exception as e:
    exception('canvas_node', f'Wystąpił błąd: {str(e)}')
```

### Używanie funkcji pomocniczych w module

```python
from python.logger import logger, LogLevel, debug, info, warn, error, exception

# Funkcje pomocnicze dla modułu
log_debug = lambda *args, **kwargs: debug('moj_modul', *args, **kwargs)
log_info = lambda *args, **kwargs: info('moj_modul', *args, **kwargs)
log_warn = lambda *args, **kwargs: warn('moj_modul', *args, **kwargs)
log_error = lambda *args, **kwargs: error('moj_modul', *args, **kwargs)
log_exception = lambda *args: exception('moj_modul', *args)

# Używanie funkcji pomocniczych
log_debug("To jest wiadomość debugowania")
log_info("To jest informacja")
log_warn("To jest ostrzeżenie")
log_error("To jest błąd")
```

## Poziomy logowania

System logowania obsługuje następujące poziomy:

- **DEBUG** - Szczegółowe informacje, przydatne podczas debugowania
- **INFO** - Ogólne informacje o działaniu aplikacji
- **WARN** - Ostrzeżenia, które nie powodują błędów, ale mogą prowadzić do problemów
- **ERROR** - Błędy, które uniemożliwiają wykonanie operacji
- **NONE** - Wyłącza wszystkie logi

## Zarządzanie logami

### JavaScript

```javascript
// Eksport logów do pliku
logger.exportLogs('json'); // Eksportuje logi do pliku JSON
logger.exportLogs('txt');  // Eksportuje logi do pliku tekstowego

// Czyszczenie logów
logger.clearLogs();
```

### Python

Logi Python są automatycznie zapisywane do plików w katalogu `logs` (lub innym skonfigurowanym), jeśli włączono opcję `log_to_file`. Pliki logów są rotowane, gdy osiągną określony rozmiar.

## Przykłady

### Przykład użycia w JavaScript

```javascript
import {logger, LogLevel} from "./logger.js";

// Inicjalizacja loggera dla modułu Canvas
const log = {
    debug: (...args) => logger.debug('Canvas', ...args),
    info: (...args) => logger.info('Canvas', ...args),
    warn: (...args) => logger.warn('Canvas', ...args),
    error: (...args) => logger.error('Canvas', ...args)
};

// Konfiguracja loggera dla modułu Canvas
logger.setModuleLevel('Canvas', LogLevel.DEBUG);

class Canvas {
    constructor() {
        log.info("Inicjalizacja Canvas");
        this.width = 512;
        this.height = 512;
    }

    render() {
        log.debug(`Renderowanie canvas o wymiarach ${this.width}x${this.height}`);
        // Kod renderowania...
        log.info("Renderowanie zakończone");
    }

    saveToServer(fileName) {
        log.info(`Zapisywanie do serwera: ${fileName}`);
        try {
            // Kod zapisywania...
            log.debug("Zapisano pomyślnie");
            return true;
        } catch (error) {
            log.error("Błąd podczas zapisywania:", error);
            return false;
        }
    }
}
```

### Przykład użycia w Python

```python
from python.logger import logger, LogLevel, debug, info, warn, error, exception

# Konfiguracja loggera dla modułu canvas_node
logger.set_module_level('canvas_node', LogLevel.DEBUG)

# Funkcje pomocnicze dla modułu
log_debug = lambda *args, **kwargs: debug('canvas_node', *args, **kwargs)
log_info = lambda *args, **kwargs: info('canvas_node', *args, **kwargs)
log_warn = lambda *args, **kwargs: warn('canvas_node', *args, **kwargs)
log_error = lambda *args, **kwargs: error('canvas_node', *args, **kwargs)
log_exception = lambda *args: exception('canvas_node', *args)

class CanvasNode:
    def __init__(self):
        log_info("Inicjalizacja CanvasNode")
        self.flow_id = "123456"
    
    def process_canvas_image(self, canvas_image, trigger, output_switch, cache_enabled, input_image=None, input_mask=None):
        try:
            log_info(f"Przetwarzanie obrazu canvas - ID wykonania: {self.flow_id}, trigger: {trigger}")
            log_debug(f"Nazwa pliku canvas: {canvas_image}")
            log_debug(f"Output switch: {output_switch}, Cache enabled: {cache_enabled}")
            
            # Kod przetwarzania...
            
            log_info("Pomyślnie zwrócono przetworzony obraz i maskę")
            return (processed_image, processed_mask)
        except Exception as e:
            log_exception(f"Błąd w process_canvas_image: {str(e)}")
            return ()
```

## Podsumowanie

System logowania ComfyUI-LayerForge zapewnia spójne i elastyczne rozwiązanie do debugowania i monitorowania aplikacji. Dzięki możliwości konfiguracji poziomów logowania per moduł, możesz skupić się na konkretnych częściach aplikacji bez zaśmiecania konsoli niepotrzebnymi informacjami.

Aby włączyć pełne debugowanie, ustaw poziom globalny na `DEBUG`:

```javascript
// JavaScript
logger.setGlobalLevel(LogLevel.DEBUG);
```

```python
# Python
logger.set_global_level(LogLevel.DEBUG)
# lub
set_debug(True)
```

Aby wyłączyć wszystkie logi:

```javascript
// JavaScript
logger.setEnabled(false);
// lub
logger.setGlobalLevel(LogLevel.NONE);
```

```python
# Python
logger.set_global_level(LogLevel.NONE)