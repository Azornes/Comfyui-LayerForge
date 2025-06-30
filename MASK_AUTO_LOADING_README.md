# Automatyczne Nakładanie Masek w Mask Editorze

## 🎯 Cel

Ta funkcjonalność rozwiązuje problem automatycznego nakładania predefiniowanych masek w mask editorze ComfyUI. Główną zaletą jest możliwość wysłania **czystego obrazu** (bez maski) do editora, a następnie automatyczne nałożenie maski w edytorze, co pozwala na prawidłowe działanie narzędzi takich jak gumka.

## ✨ Kluczowe Zalety

- 🖼️ **Czysty Obraz**: Wysyłanie obrazu bez istniejącej maski
- 🎨 **Prawidłowa Gumka**: Editor "pamięta" oryginalny obraz pod maską
- ⚡ **Automatyzacja**: Maska nakładana automatycznie po otwarciu
- 🔄 **Kompatybilność**: Obsługa nowego i starego mask editora
- 📐 **Elastyczność**: Różne formaty masek (Image, Canvas)

## 🚀 Szybki Start

### Automatyczne Zachowanie (Zalecane)

```javascript
import { start_mask_editor_auto } from './js/utils/mask_utils.js';

// Uruchom mask editor z automatycznym zachowaniem:
// - Wyślij czysty obraz (bez maski)
// - Automatycznie nałóż istniejącą maskę z canvas
start_mask_editor_auto(canvasInstance);
```

### Użycie z Predefiniowaną Maską

```javascript
import { start_mask_editor_with_predefined_mask, create_mask_from_image_src } from './js/utils/mask_utils.js';

// Załaduj maskę z URL
const maskImage = await create_mask_from_image_src('/path/to/mask.png');

// Uruchom mask editor z czystym obrazem i predefiniowaną maską
start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
```

### Bezpośrednie Użycie Canvas API

```javascript
// Automatyczne zachowanie (domyślne)
await canvasInstance.startMaskEditor();

// Z predefiniowaną maską
await canvasInstance.startMaskEditor(maskImage, true);
```

## 📚 API Reference

### Canvas.startMaskEditor(predefinedMask, sendCleanImage)

**Parametry:**
- `predefinedMask` (Image|HTMLCanvasElement|null) - Maska do nałożenia
- `sendCleanImage` (boolean) - Czy wysłać czysty obraz (domyślnie false)

### Funkcje Pomocnicze

#### `start_mask_editor_with_predefined_mask(canvasInstance, maskImage, sendCleanImage)`
Główna funkcja pomocnicza do uruchamiania editora z maską.

#### `create_mask_from_image_src(imageSrc)`
Tworzy obiekt Image z URL.

#### `canvas_to_mask_image(canvas)`
Konwertuje Canvas do Image.

## 💡 Przykłady Użycia

### 1. Maska z URL
```javascript
const maskImage = await create_mask_from_image_src('/masks/face_mask.png');
start_mask_editor_with_predefined_mask(canvas, maskImage, true);
```

### 2. Maska z Canvas
```javascript
// Stwórz maskę programowo
const maskCanvas = document.createElement('canvas');
const ctx = maskCanvas.getContext('2d');
// ... rysowanie maski ...

const maskImage = await canvas_to_mask_image(maskCanvas);
start_mask_editor_with_predefined_mask(canvas, maskImage, true);
```

### 3. Maska z Danych Binarnych
```javascript
const blob = new Blob([binaryData], { type: 'image/png' });
const dataUrl = URL.createObjectURL(blob);
const maskImage = await create_mask_from_image_src(dataUrl);
start_mask_editor_with_predefined_mask(canvas, maskImage, true);
```

## 🔧 Jak to Działa

### 1. Przygotowanie Obrazu
System wybiera odpowiednią metodę w zależności od parametru `sendCleanImage`:
- `true`: Wysyła czysty obraz bez maski
- `false`: Wysyła obraz z istniejącą maską

### 2. Otwieranie Editora
Standardowy proces otwierania mask editora ComfyUI.

### 3. Automatyczne Nakładanie
Po otwarciu editora system:
- Wykrywa typ editora (nowy/stary)
- Przetwarza maskę do odpowiedniego formatu
- Nakłada maskę na canvas editora
- Zapisuje stan dla undo/redo

## 🎛️ Tryby Działania

### Czysty Obraz (Zalecany)
```javascript
// Wyślij czysty obraz, nałóż maskę w edytorze
await canvas.startMaskEditor(maskImage, true);
```
**Zalety:**
- Gumka działa prawidłowo
- Editor "pamięta" oryginalny obraz
- Pełna funkcjonalność narzędzi

### Kombinowany
```javascript
// Wyślij obraz z istniejącą maską, dodaj nową maskę
await canvas.startMaskEditor(maskImage, false);
```
**Zastosowanie:**
- Łączenie wielu masek
- Dodawanie do istniejącej maski

## 🔍 Obsługa Błędów

```javascript
try {
    const maskImage = await create_mask_from_image_src('/path/to/mask.png');
    start_mask_editor_with_predefined_mask(canvas, maskImage, true);
} catch (error) {
    console.error('Błąd ładowania maski:', error);
    // Fallback - uruchom bez maski
    await canvas.startMaskEditor();
}
```

## 🏗️ Architektura

### Komponenty
- **Canvas.js**: Główna logika i API
- **mask_utils.js**: Funkcje pomocnicze
- **Detektory Editora**: Automatyczne wykrywanie typu editora
- **Procesory Masek**: Konwersja formatów

### Przepływ Danych
```
Maska → Przetwarzanie → Editor → Automatyczne Nakładanie
```

## 🔧 Konfiguracja

### Wymagania
- ComfyUI z mask editorem
- Obsługa ES6 modules
- Canvas API

### Integracja
```javascript
import { Canvas } from './js/Canvas.js';
import { start_mask_editor_with_predefined_mask } from './js/utils/mask_utils.js';
```

## 📋 Przypadki Użycia

- 🤖 **AI/ML Modele**: Automatyczne maski z modeli
- 📝 **Szablony**: Predefiniowane wzorce masek
- 🔗 **Integracje**: Zewnętrzne narzędzia i API
- ⚙️ **Workflow**: Automatyzacja procesów
- 📦 **Batch Processing**: Masowe przetwarzanie

## 🐛 Rozwiązywanie Problemów

### Maska się nie nakłada
- Sprawdź czy obraz maski jest załadowany
- Upewnij się że editor jest w pełni otwarty
- Sprawdź logi w konsoli

### Gumka nie działa
- Użyj `sendCleanImage = true`
- Sprawdź czy maska ma prawidłowy kanał alpha

### Błędy kompatybilności
- Sprawdź ustawienia mask editora w ComfyUI
- Upewnij się że używasz odpowiedniej wersji

## 📁 Struktura Plików

```
js/
├── Canvas.js                    # Główne API
├── utils/
│   └── mask_utils.js           # Funkcje pomocnicze
├── examples/
│   └── mask_editor_examples.js # Przykłady użycia
└── Doc/
    └── AutoMaskLoading         # Szczegółowa dokumentacja
```

## 🔄 Kompatybilność

- ✅ Nowy mask editor ComfyUI (MessageBroker)
- ✅ Stary mask editor ComfyUI (bezpośredni dostęp)
- ✅ Wszystkie formaty masek (Image, Canvas, URL)
- ✅ Automatyczne wykrywanie konfiguracji

## 📈 Wydajność

- Minimalne opóźnienie nakładania (200ms)
- Automatyczna optymalizacja formatów
- Efektywne zarządzanie pamięcią
- Asynchroniczne operacje

---

**Autor:** Cline AI Assistant  
**Wersja:** 1.0.0  
**Data:** 2025-06-30
