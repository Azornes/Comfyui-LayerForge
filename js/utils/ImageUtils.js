import {createModuleLogger} from "./LoggerUtils.js";
import {withErrorHandling, createValidationError} from "../ErrorHandler.js";
const log = createModuleLogger('ImageUtils');

export function validateImageData(data) {
    log.debug("Validating data structure:", {
        hasData: !!data,
        type: typeof data,
        isArray: Array.isArray(data),
        keys: data ? Object.keys(data) : null,
        shape: data?.shape,
        dataType: data?.data ? data.data.constructor.name : null,
        fullData: data
    });

    if (!data) {
        log.info("Data is null or undefined");
        return false;
    }

    if (Array.isArray(data)) {
        log.debug("Data is array, getting first element");
        data = data[0];
    }

    if (!data || typeof data !== 'object') {
        log.info("Invalid data type");
        return false;
    }

    if (!data.data) {
        log.info("Missing data property");
        return false;
    }

    if (!(data.data instanceof Float32Array)) {
        try {
            data.data = new Float32Array(data.data);
        } catch (e) {
            log.error("Failed to convert data to Float32Array:", e);
            return false;
        }
    }

    return true;
}

export function convertImageData(data) {
    log.info("Converting image data:", data);

    if (Array.isArray(data)) {
        data = data[0];
    }

    const shape = data.shape;
    const height = shape[1];
    const width = shape[2];
    const channels = shape[3];
    const floatData = new Float32Array(data.data);

    log.debug("Processing dimensions:", {height, width, channels});

    const rgbaData = new Uint8ClampedArray(width * height * 4);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const tensorIndex = (h * width + w) * channels;

            for (let c = 0; c < channels; c++) {
                const value = floatData[tensorIndex + c];
                rgbaData[pixelIndex + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
            }

            rgbaData[pixelIndex + 3] = 255;
        }
    }

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}

export function applyMaskToImageData(imageData, maskData) {
    log.info("Applying mask to image data");

    const rgbaData = new Uint8ClampedArray(imageData.data);
    const width = imageData.width;
    const height = imageData.height;

    const maskShape = maskData.shape;
    const maskFloatData = new Float32Array(maskData.data);

    log.debug(`Applying mask of shape: ${maskShape}`);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const maskIndex = h * width + w;

            const alpha = maskFloatData[maskIndex];
            rgbaData[pixelIndex + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
        }
    }

    log.info("Mask application completed");

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}

export const prepareImageForCanvas = withErrorHandling(function(inputImage) {
    log.info("Preparing image for canvas:", inputImage);

    if (Array.isArray(inputImage)) {
        inputImage = inputImage[0];
    }

    if (!inputImage || !inputImage.shape || !inputImage.data) {
        throw createValidationError("Invalid input image format", { inputImage });
    }

    const shape = inputImage.shape;
    const height = shape[1];
    const width = shape[2];
    const channels = shape[3];
    const floatData = new Float32Array(inputImage.data);

    log.debug("Image dimensions:", {height, width, channels});

    const rgbaData = new Uint8ClampedArray(width * height * 4);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const tensorIndex = (h * width + w) * channels;

            for (let c = 0; c < channels; c++) {
                const value = floatData[tensorIndex + c];
                rgbaData[pixelIndex + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
            }

            rgbaData[pixelIndex + 3] = 255;
        }
    }

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}, 'prepareImageForCanvas');

/**
 * Konwertuje obraz PIL/Canvas na tensor
 * @param {HTMLImageElement|HTMLCanvasElement} image - Obraz do konwersji
 * @returns {Promise<Object>} Tensor z danymi obrazu
 */
export const imageToTensor = withErrorHandling(async function(image) {
    if (!image) {
        throw createValidationError("Image is required");
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = image.width || image.naturalWidth;
    canvas.height = image.height || image.naturalHeight;
    
    ctx.drawImage(image, 0, 0);
    
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = new Float32Array(canvas.width * canvas.height * 3);
    
    for (let i = 0; i < imageData.data.length; i += 4) {
        const pixelIndex = i / 4;
        data[pixelIndex * 3] = imageData.data[i] / 255;
        data[pixelIndex * 3 + 1] = imageData.data[i + 1] / 255;
        data[pixelIndex * 3 + 2] = imageData.data[i + 2] / 255;
    }
    
    return {
        data: data,
        shape: [1, canvas.height, canvas.width, 3],
        width: canvas.width,
        height: canvas.height
    };
}, 'imageToTensor');

/**
 * Konwertuje tensor na obraz HTML
 * @param {Object} tensor - Tensor z danymi obrazu
 * @returns {Promise<HTMLImageElement>} Obraz HTML
 */
export const tensorToImage = withErrorHandling(async function(tensor) {
    if (!tensor || !tensor.data || !tensor.shape) {
        throw createValidationError("Invalid tensor format", { tensor });
    }

    const [, height, width, channels] = tensor.shape;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = width;
    canvas.height = height;
    
    const imageData = ctx.createImageData(width, height);
    const data = tensor.data;
    
    for (let i = 0; i < width * height; i++) {
        const pixelIndex = i * 4;
        const tensorIndex = i * channels;
        
        imageData.data[pixelIndex] = Math.round(data[tensorIndex] * 255);
        imageData.data[pixelIndex + 1] = Math.round(data[tensorIndex + 1] * 255);
        imageData.data[pixelIndex + 2] = Math.round(data[tensorIndex + 2] * 255);
        imageData.data[pixelIndex + 3] = 255;
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = canvas.toDataURL();
    });
}, 'tensorToImage');

/**
 * Zmienia rozmiar obrazu z zachowaniem proporcji
 * @param {HTMLImageElement} image - Obraz do przeskalowania
 * @param {number} maxWidth - Maksymalna szerokość
 * @param {number} maxHeight - Maksymalna wysokość
 * @returns {Promise<HTMLImageElement>} Przeskalowany obraz
 */
export const resizeImage = withErrorHandling(async function(image, maxWidth, maxHeight) {
    if (!image) {
        throw createValidationError("Image is required");
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const originalWidth = image.width || image.naturalWidth;
    const originalHeight = image.height || image.naturalHeight;
    const scale = Math.min(maxWidth / originalWidth, maxHeight / originalHeight);
    const newWidth = Math.round(originalWidth * scale);
    const newHeight = Math.round(originalHeight * scale);
    
    canvas.width = newWidth;
    canvas.height = newHeight;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    
    ctx.drawImage(image, 0, 0, newWidth, newHeight);
    
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = canvas.toDataURL();
    });
}, 'resizeImage');

/**
 * Tworzy miniaturę obrazu
 * @param {HTMLImageElement} image - Obraz źródłowy
 * @param {number} size - Rozmiar miniatury (kwadrat)
 * @returns {Promise<HTMLImageElement>} Miniatura
 */
export const createThumbnail = withErrorHandling(async function(image, size = 128) {
    return resizeImage(image, size, size);
}, 'createThumbnail');

/**
 * Konwertuje obraz na base64
 * @param {HTMLImageElement|HTMLCanvasElement} image - Obraz do konwersji
 * @param {string} format - Format obrazu (png, jpeg, webp)
 * @param {number} quality - Jakość (0-1) dla formatów stratnych
 * @returns {string} Base64 string
 */
export const imageToBase64 = withErrorHandling(function(image, format = 'png', quality = 0.9) {
    if (!image) {
        throw createValidationError("Image is required");
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = image.width || image.naturalWidth;
    canvas.height = image.height || image.naturalHeight;
    
    ctx.drawImage(image, 0, 0);
    
    const mimeType = `image/${format}`;
    return canvas.toDataURL(mimeType, quality);
}, 'imageToBase64');

/**
 * Konwertuje base64 na obraz
 * @param {string} base64 - Base64 string
 * @returns {Promise<HTMLImageElement>} Obraz
 */
export const base64ToImage = withErrorHandling(function(base64) {
    if (!base64) {
        throw createValidationError("Base64 string is required");
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image from base64"));
        img.src = base64;
    });
}, 'base64ToImage');

/**
 * Sprawdza czy obraz jest prawidłowy
 * @param {HTMLImageElement} image - Obraz do sprawdzenia
 * @returns {boolean} Czy obraz jest prawidłowy
 */
export function isValidImage(image) {
    return image && 
           (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) &&
           image.width > 0 && 
           image.height > 0;
}

/**
 * Pobiera informacje o obrazie
 * @param {HTMLImageElement} image - Obraz
 * @returns {Object} Informacje o obrazie
 */
export function getImageInfo(image) {
    if (!isValidImage(image)) {
        return null;
    }

    return {
        width: image.width || image.naturalWidth,
        height: image.height || image.naturalHeight,
        aspectRatio: (image.width || image.naturalWidth) / (image.height || image.naturalHeight),
        area: (image.width || image.naturalWidth) * (image.height || image.naturalHeight)
    };
}

/**
 * Tworzy obraz z podanego źródła - eliminuje duplikaty w kodzie
 * @param {string} source - Źródło obrazu (URL, data URL, etc.)
 * @returns {Promise<HTMLImageElement>} Promise z obrazem
 */
export function createImageFromSource(source) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = source;
    });
}

/**
 * Tworzy pusty obraz o podanych wymiarach
 * @param {number} width - Szerokość
 * @param {number} height - Wysokość
 * @param {string} color - Kolor tła (CSS color)
 * @returns {Promise<HTMLImageElement>} Pusty obraz
 */
export const createEmptyImage = withErrorHandling(function(width, height, color = 'transparent') {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    canvas.width = width;
    canvas.height = height;
    
    if (color !== 'transparent') {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
    }
    
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = canvas.toDataURL();
    });
}, 'createEmptyImage');
