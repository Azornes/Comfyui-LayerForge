import {$el} from "../../../scripts/ui.js";

export function addStylesheet(url) {
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

export function getUrl(path, baseUrl) {
    if (baseUrl) {
        return new URL(path, baseUrl).toString();
    } else {
        return new URL("../" + path, import.meta.url).toString();
    }
}

export async function loadTemplate(path, baseUrl) {
    const url = getUrl(path, baseUrl);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to load template: ${url}`);
    }
    return await response.text();
}
