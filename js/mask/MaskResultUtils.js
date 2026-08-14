import { convertToImage } from "../media/ImageUtils.js";
import { processImageToMask } from "./MaskProcessingUtils.js";
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
