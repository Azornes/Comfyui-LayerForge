#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

import {
    applyLuminanceAsAlpha,
    calculateDistanceTransform,
    fillInverseAlphaMask,
    rasterizeDistanceFieldMask,
} from '../js/mask/mask_pixel_utils.js';
import { HistoryStack } from '../js/canvas/canvas_history.js';
import { cloneLayers, getStateSignature } from '../js/utils/common_utils.js';

const DEFAULT_SIZES = [512, 1024, 2048];
const DEFAULT_LAYER_COUNTS = [1, 4, 8, 16];
const DEFAULT_ITERATIONS = 5;

function parseList(value, fallback) {
    if (value === undefined) return fallback;

    const parsed = value
        .split(',')
        .map(item => Number.parseInt(item.trim(), 10))
        .filter(Number.isFinite);

    if (parsed.length === 0 || parsed.some(item => item <= 0)) {
        throw new Error(`Expected a comma-separated list of positive integers, got: ${value}`);
    }

    return parsed;
}

function parseOptions(argv) {
    const options = {
        format: 'table',
        sizes: DEFAULT_SIZES,
        layerCounts: DEFAULT_LAYER_COUNTS,
        iterations: DEFAULT_ITERATIONS,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') {
            options.help = true;
            continue;
        }

        const value = argv[index + 1];
        if (value === undefined) {
            throw new Error(`Missing value for ${argument}`);
        }

        if (argument === '--format') {
            if (!['table', 'json'].includes(value)) {
                throw new Error(`Unsupported format: ${value}`);
            }
            options.format = value;
        } else if (argument === '--sizes') {
            options.sizes = parseList(value, DEFAULT_SIZES);
        } else if (argument === '--layer-counts') {
            options.layerCounts = parseList(value, DEFAULT_LAYER_COUNTS);
        } else if (argument === '--iterations') {
            options.iterations = Number.parseInt(value, 10);
            if (!Number.isFinite(options.iterations) || options.iterations < 1) {
                throw new Error(`Expected --iterations to be a positive integer, got: ${value}`);
            }
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }

        index += 1;
    }

    return options;
}

function printHelp() {
    console.log(`LayerForge offline frontend benchmark

Usage:
  npm run benchmark -- [options]

Options:
  --sizes 512,1024,2048       Pixel benchmark sizes
  --layer-counts 1,4,8,16     History/model benchmark sizes
  --iterations 5              Timed samples per operation
  --format table|json         Output format (default: table)
`);
}

function percentile(sortedValues, percentileValue) {
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1),
    );
    return sortedValues[index];
}

function measureSync(operation, iterations) {
    const warmupCount = Math.min(2, iterations);
    for (let index = 0; index < warmupCount; index += 1) {
        operation();
    }

    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
        const startedAt = performance.now();
        operation();
        samples.push(performance.now() - startedAt);
    }

    const sorted = samples.slice().sort((left, right) => left - right);
    return {
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        minMs: sorted[0],
        maxMs: sorted[sorted.length - 1],
    };
}

function createBinaryMask(size) {
    const mask = new Uint8Array(size * size);
    const center = size / 2;
    const radius = size * 0.36;

    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            const dx = x - center;
            const dy = y - center;
            mask[y * size + x] = dx * dx + dy * dy <= radius * radius ? 1 : 0;
        }
    }

    return mask;
}

function createImageData(size) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let index = 0; index < data.length; index += 4) {
        data[index] = index & 255;
        data[index + 1] = (index >> 3) & 255;
        data[index + 2] = (index >> 5) & 255;
        data[index + 3] = 255;
    }
    return { data };
}

function benchmarkPixelOperations(size, iterations) {
    const pixelCount = size * size;
    const binaryMask = createBinaryMask(size);
    const distanceMap = calculateDistanceTransform(binaryMask, size, size);
    const rasterizedData = new Uint8ClampedArray(pixelCount * 4);
    const imageData = createImageData(size);
    const visibilityData = { data: new Uint8ClampedArray(pixelCount * 4) };
    const maskData = { data: new Uint8ClampedArray(pixelCount * 4).fill(255) };

    return {
        distanceTransform: measureSync(
            () => calculateDistanceTransform(binaryMask, size, size),
            iterations,
        ),
        rasterizeDistanceField: measureSync(
            () => rasterizeDistanceFieldMask(distanceMap, binaryMask, size * 0.1, rasterizedData),
            iterations,
        ),
        luminanceToAlpha: measureSync(
            () => applyLuminanceAsAlpha(imageData),
            iterations,
        ),
        inverseAlphaMask: measureSync(
            () => fillInverseAlphaMask(visibilityData, maskData),
            iterations,
        ),
    };
}

function createLayerModel(count, size) {
    return Array.from({ length: count }, (_, index) => ({
        id: `benchmark-layer-${index}`,
        x: (index % 4) * size * 0.04,
        y: Math.floor(index / 4) * size * 0.04,
        width: size * 0.72,
        height: size * 0.72,
        originalWidth: size,
        originalHeight: size,
        rotation: (index * 7) % 30,
        zIndex: index,
        blendMode: index % 3 === 0 ? 'normal' : 'multiply',
        opacity: 0.7 + ((index % 3) * 0.1),
        flipH: index % 5 === 0,
        flipV: index % 7 === 0,
        blendArea: index % 2 === 0 ? 25 : 0,
        cropBounds: index % 3 === 0
            ? { x: size * 0.1, y: size * 0.1, width: size * 0.8, height: size * 0.8 }
            : undefined,
        imageId: `benchmark-image-${index}`,
        image: { src: 'data:image/png;base64,benchmark-placeholder' },
    }));
}

function benchmarkHistory(count, size, iterations) {
    const layers = createLayerModel(count, size);
    const history = new HistoryStack({
        clone: cloneLayers,
        equals: (left, right) => getStateSignature(left) === getStateSignature(right),
        historyLimit: 100,
    });

    return {
        cloneLayers: measureSync(() => cloneLayers(layers), iterations),
        stateSignature: measureSync(() => getStateSignature(layers), iterations),
        pushSnapshot: measureSync(() => {
            history.clear();
            history.push(layers);
        }, iterations),
        estimatedSnapshotBytes: new TextEncoder().encode(JSON.stringify(cloneLayers(layers))).byteLength,
    };
}

function roundStats(stats) {
    return Object.fromEntries(
        Object.entries(stats).map(([key, value]) => [
            key,
            typeof value === 'number' ? Number(value.toFixed(3)) : value,
        ]),
    );
}

function printTable(report) {
    console.log('LayerForge offline frontend benchmark');
    console.log(`Node ${report.runtime.node} on ${report.runtime.platform} ${report.runtime.arch}`);
    console.log(`Iterations: ${report.config.iterations}`);
    console.log('');
    console.log('Pixel operations');
    console.log('size  operation                 median   p95');

    for (const [size, operations] of Object.entries(report.pixelOperations)) {
        for (const [operation, stats] of Object.entries(operations)) {
            console.log(
                `${size.padStart(4)}  ${operation.padEnd(25)} `
                + `${stats.medianMs.toFixed(3).padStart(7)} ms `
                + `${stats.p95Ms.toFixed(3).padStart(7)} ms`,
            );
        }
    }

    console.log('');
    console.log('Layer model/history operations');
    console.log('layers  operation                 median   p95');
    for (const [count, operations] of Object.entries(report.layerModel)) {
        for (const operation of ['cloneLayers', 'stateSignature', 'pushSnapshot']) {
            const stats = operations[operation];
            console.log(
                `${count.padStart(6)}  ${operation.padEnd(25)} `
                + `${stats.medianMs.toFixed(3).padStart(7)} ms `
                + `${stats.p95Ms.toFixed(3).padStart(7)} ms`,
            );
        }
    }

    console.log('');
    console.log('Browser Canvas render/export: run benchmarks/browser.html in a browser.');
}

function main() {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    const report = {
        benchmark: 'layerforge-frontend-offline',
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        config: {
            sizes: options.sizes,
            layerCounts: options.layerCounts,
            iterations: options.iterations,
        },
        pixelOperations: {},
        layerModel: {},
        skipped: [
            {
                benchmark: 'browser-canvas-render-export',
                reason: 'Use benchmarks/browser.html with a real browser Canvas implementation.',
            },
        ],
    };

    for (const size of options.sizes) {
        report.pixelOperations[size] = Object.fromEntries(
            Object.entries(benchmarkPixelOperations(size, options.iterations))
                .map(([name, stats]) => [name, roundStats(stats)]),
        );
    }

    const historySize = options.sizes[0];
    for (const count of options.layerCounts) {
        report.layerModel[count] = {
            ...benchmarkHistory(count, historySize, options.iterations),
        };
        report.layerModel[count] = Object.fromEntries(
            Object.entries(report.layerModel[count]).map(([name, value]) => [
                name,
                typeof value === 'object' ? roundStats(value) : value,
            ]),
        );
    }

    if (options.format === 'json') {
        console.log(JSON.stringify(report, null, 2));
        return;
    }

    printTable(report);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
