export interface MattingModelStatus<Model = unknown> {
    available: boolean;
    reason: string;
    message: string;
    models?: Model[];
}

export interface MattingModelStatusResult<Model = unknown> {
    ok: boolean;
    data: MattingModelStatus<Model>;
}

export async function fetchMattingModelStatus<Model = unknown>(
    modelPath?: string,
): Promise<MattingModelStatusResult<Model>> {
    const query = modelPath
        ? `?model_path=${encodeURIComponent(modelPath)}`
        : '';
    const response = await fetch(`/matting/check-model${query}`);
    const data = await response.json() as MattingModelStatus<Model>;

    return { ok: response.ok, data };
}
