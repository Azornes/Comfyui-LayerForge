import { convertToImage } from "../media/image_utils.js";
import { processImageToMask } from "./mask_processing_utils.js";
export async function createMaskImageFromResult(sourceImage, options) {
    const processedMask = await processImageToMask(sourceImage, {
        targetWidth: options.targetWidth,
        targetHeight: options.targetHeight,
        invertAlpha: options.invertAlpha ?? true,
    });
    return convertToImage(processedMask);
}
export async function applyMaskResultToTool(sourceImage, options, resolveTarget) {
    const maskImage = await createMaskImageFromResult(sourceImage, options);
    resolveTarget().setMask(maskImage);
    return maskImage;
}
