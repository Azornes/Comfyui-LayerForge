// @ts-ignore
import { $el } from "../../../scripts/ui.js";

export function addStylesheet(url: string): void {
    if (url.endsWith(".js")) {
        url = url.substr(0, url.length - 2) + "css";
    }
    $el("link", {
        parent: document.head,
        rel: "stylesheet",
        type: "text/css",
        href: url.startsWith("http") ? url : getUrl(url),
    });
}

export function getUrl(path: string, baseUrl?: string | URL): string {
    if (baseUrl) {
        return new URL(path, baseUrl).toString();    
    } else {
         // @ts-ignore
        return new URL("../" + path, import.meta.url).toString();
    }
}

export async function loadTemplate(path: string, baseUrl?: string | URL): Promise<string> {
    const url = getUrl(path, baseUrl);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load template: ${url}`);
    }
    return await response.text();
}
