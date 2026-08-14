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

export interface MattingServerSettings {
    model_path: string;
    mode: string;
    threshold: number;
    hf_token_configured: boolean;
    configured: boolean;
}

export interface MattingSettingsResponse {
    ok: boolean;
    data: {
        settings?: MattingServerSettings;
        error?: string;
    };
}

export interface MattingSettingsUpdate {
    model_path?: string;
    mode?: string;
    threshold?: number;
    hf_token?: string;
    clear_hf_token?: boolean;
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

export async function fetchMattingSettings(): Promise<MattingSettingsResponse> {
    const response = await fetch('/matting/settings');
    const data = await response.json() as MattingSettingsResponse['data'];
    return { ok: response.ok, data };
}

export async function saveMattingSettings(
    settings: MattingSettingsUpdate,
): Promise<MattingSettingsResponse> {
    const response = await fetch('/matting/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });
    const data = await response.json() as MattingSettingsResponse['data'];
    return { ok: response.ok, data };
}
