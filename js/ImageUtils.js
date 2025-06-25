export function validateImageData(data) {
    console.log("Validating data structure:", {
        hasData: !!data,
        type: typeof data,
        isArray: Array.isArray(data),
        keys: data ? Object.keys(data) : null,
        shape: data?.shape,
        dataType: data?.data ? data.data.constructor.name : null,
        fullData: data
    });

    if (!data) {
        console.log("Data is null or undefined");
        return false;
    }

    if (Array.isArray(data)) {
        console.log("Data is array, getting first element");
        data = data[0];
    }

    if (!data || typeof data !== 'object') {
        console.log("Invalid data type");
        return false;
    }

    if (!data.data) {
        console.log("Missing data property");
        return false;
    }

    if (!(data.data instanceof Float32Array)) {
        try {
            data.data = new Float32Array(data.data);
        } catch (e) {
            console.log("Failed to convert data to Float32Array:", e);
            return false;
        }
    }

    return true;
}

export function convertImageData(data) {
    console.log("Converting image data:", data);

    if (Array.isArray(data)) {
        data = data[0];
    }

    const shape = data.shape;
    const height = shape[1];
    const width = shape[2];
    const channels = shape[3];
    const floatData = new Float32Array(data.data);

    console.log("Processing dimensions:", {height, width, channels});

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
    console.log("Applying mask to image data");

    const rgbaData = new Uint8ClampedArray(imageData.data);
    const width = imageData.width;
    const height = imageData.height;

    const maskShape = maskData.shape;
    const maskFloatData = new Float32Array(maskData.data);

    console.log(`Applying mask of shape: ${maskShape}`);

    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            const pixelIndex = (h * width + w) * 4;
            const maskIndex = h * width + w;

            const alpha = maskFloatData[maskIndex];
            rgbaData[pixelIndex + 3] = Math.max(0, Math.min(255, Math.round(alpha * 255)));
        }
    }

    console.log("Mask application completed");

    return {
        data: rgbaData,
        width: width,
        height: height
    };
}

export function prepareImageForCanvas(inputImage) {
    console.log("Preparing image for canvas:", inputImage);

    try {
        if (Array.isArray(inputImage)) {
            inputImage = inputImage[0];
        }

        if (!inputImage || !inputImage.shape || !inputImage.data) {
            throw new Error("Invalid input image format");
        }

        const shape = inputImage.shape;
        const height = shape[1];
        const width = shape[2];
        const channels = shape[3];
        const floatData = new Float32Array(inputImage.data);

        console.log("Image dimensions:", {height, width, channels});

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
    } catch (error) {
        console.error("Error preparing image:", error);
        throw new Error(`Failed to prepare image: ${error.message}`);
    }
}