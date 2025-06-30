/**
 * Przykłady użycia automatycznego nakładania masek w mask editorze
 * 
 * Te przykłady pokazują jak używać nowej funkcjonalności do automatycznego
 * nakładania predefiniowanych masek po otwarciu mask editora ComfyUI.
 */

import { 
    start_mask_editor_with_predefined_mask, 
    create_mask_from_image_src, 
    canvas_to_mask_image 
} from '../utils/mask_utils.js';

/**
 * Przykład 1: Podstawowe użycie z obrazem maski
 */
async function example1_basic_usage(canvasInstance) {
    // Załaduj obraz maski z URL
    const maskImage = await create_mask_from_image_src('/path/to/mask.png');
    
    // Uruchom mask editor z predefiniowaną maską
    // sendCleanImage = true oznacza że wyślemy czysty obraz bez istniejącej maski
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
}

/**
 * Przykład 2: Użycie z canvas jako maska
 */
async function example2_canvas_mask(canvasInstance) {
    // Stwórz canvas z maską programowo
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = 512;
    maskCanvas.height = 512;
    const ctx = maskCanvas.getContext('2d');
    
    // Narysuj prostą maskę - białe koło na czarnym tle
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(256, 256, 100, 0, 2 * Math.PI);
    ctx.fill();
    
    // Konwertuj canvas do Image
    const maskImage = await canvas_to_mask_image(maskCanvas);
    
    // Uruchom mask editor
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
}

/**
 * Przykład 3: Bezpośrednie użycie metody Canvas
 */
async function example3_direct_canvas_method(canvasInstance) {
    // Załaduj maskę
    const maskImage = await create_mask_from_image_src('/path/to/mask.png');
    
    // Bezpośrednie wywołanie metody Canvas
    // Parametr 1: predefiniowana maska
    // Parametr 2: czy wysłać czysty obraz (true = tak, false = z istniejącą maską)
    await canvasInstance.startMaskEditor(maskImage, true);
}

/**
 * Przykład 4: Tworzenie maski z danych binarnych
 */
async function example4_binary_data_mask(canvasInstance, binaryData) {
    // Konwertuj dane binarne do data URL
    const blob = new Blob([binaryData], { type: 'image/png' });
    const dataUrl = URL.createObjectURL(blob);
    
    // Stwórz obraz z data URL
    const maskImage = await create_mask_from_image_src(dataUrl);
    
    // Uruchom mask editor
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
    
    // Wyczyść URL po użyciu
    URL.revokeObjectURL(dataUrl);
}

/**
 * Przykład 5: Maska z gradientem
 */
async function example5_gradient_mask(canvasInstance) {
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = 512;
    maskCanvas.height = 512;
    const ctx = maskCanvas.getContext('2d');
    
    // Stwórz gradient od przezroczystego do białego
    const gradient = ctx.createLinearGradient(0, 0, 512, 0);
    gradient.addColorStop(0, 'rgba(0, 0, 0, 0)');    // Przezroczysty
    gradient.addColorStop(1, 'rgba(255, 255, 255, 1)'); // Biały
    
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 512, 512);
    
    const maskImage = await canvas_to_mask_image(maskCanvas);
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
}

/**
 * Przykład 6: Obsługa błędów
 */
async function example6_error_handling(canvasInstance) {
    try {
        const maskImage = await create_mask_from_image_src('/path/to/nonexistent.png');
        start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
    } catch (error) {
        console.error('Błąd podczas ładowania maski:', error);
        
        // Fallback - uruchom editor bez predefiniowanej maski
        await canvasInstance.startMaskEditor();
    }
}

/**
 * Przykład 7: Maska z istniejącego elementu canvas na stronie
 */
async function example7_existing_canvas_element(canvasInstance, canvasElementId) {
    const existingCanvas = document.getElementById(canvasElementId);
    if (!existingCanvas) {
        console.error('Canvas element not found:', canvasElementId);
        return;
    }
    
    const maskImage = await canvas_to_mask_image(existingCanvas);
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, true);
}

/**
 * Przykład 8: Kombinowanie z istniejącą maską
 */
async function example8_combine_with_existing_mask(canvasInstance) {
    const maskImage = await create_mask_from_image_src('/path/to/mask.png');
    
    // sendCleanImage = false oznacza że wyślemy obraz z istniejącą maską
    // Nowa maska zostanie nałożona dodatkowo w edytorze
    start_mask_editor_with_predefined_mask(canvasInstance, maskImage, false);
}

// Eksportuj przykłady dla użycia w innych plikach
export {
    example1_basic_usage,
    example2_canvas_mask,
    example3_direct_canvas_method,
    example4_binary_data_mask,
    example5_gradient_mask,
    example6_error_handling,
    example7_existing_canvas_element,
    example8_combine_with_existing_mask
};
