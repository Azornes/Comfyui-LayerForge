import {convertToImage} from "../media/ImageUtils.js";
import {processImageToMask} from "./MaskProcessingUtils.js";

export interface MaskResultOptions {
    targetWidth: number;
    targetHeight: number;
    invertAlpha?: boolean;
}

export async function createMaskImageFromResult(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    options: MaskResultOptions
): Promise<HTMLImageElement> {
    const processedMask = await processImageToMask(sourceImage, {
        targetWidth: options.targetWidth,
        targetHeight: options.targetHeight,
        invertAlpha: options.invertAlpha ?? true,
    });

    return convertToImage(processedMask);
}

interface MaskResultTarget {
    setMask(image: HTMLImageElement): void;
}

export async function applyMaskResultToTool(
    sourceImage: HTMLImageElement | HTMLCanvasElement,
    options: MaskResultOptions,
    resolveTarget: () => MaskResultTarget
): Promise<HTMLImageElement> {
    const maskImage = await createMaskImageFromResult(sourceImage, options);
    resolveTarget().setMask(maskImage);
    return maskImage;
}
