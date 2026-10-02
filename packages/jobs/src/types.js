"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSettingsMap = parseSettingsMap;
function parseSettingsMap(map) {
    const raw = map instanceof Map ? Object.fromEntries(map.entries()) : { ...map };
    const getVal = (name) => {
        const target = name.toLowerCase();
        for (const [k, v] of Object.entries(raw)) {
            if (k.toLowerCase() === target) {
                return v;
            }
        }
        return undefined;
    };
    let maxRequestsPerJob;
    const maxReqRaw = getVal('MaxRequestsPerJob') ?? getVal('MaxRequests');
    if (maxReqRaw !== undefined && maxReqRaw.trim().length > 0) {
        const parsed = Number(maxReqRaw.trim());
        if (!isNaN(parsed) && parsed > 0) {
            maxRequestsPerJob = parsed;
        }
    }
    let adminId;
    const adminIdRaw = getVal('AdminID');
    if (adminIdRaw !== undefined && adminIdRaw.trim().length > 0) {
        const parsed = Number(adminIdRaw.trim());
        if (!isNaN(parsed) && parsed > 0) {
            adminId = parsed;
        }
    }
    let errorListeners = [];
    const errorListenersRaw = getVal('ErrorListeners');
    if (errorListenersRaw !== undefined && errorListenersRaw.trim().length > 0) {
        const trimmed = errorListenersRaw.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    errorListeners = parsed
                        .map(x => Number(x))
                        .filter(n => !isNaN(n) && n > 0);
                }
            }
            catch {
                // Fall back to comma-separated if json parse fails
            }
        }
        if (errorListeners.length === 0) {
            errorListeners = trimmed
                .replace(/^\[|\]$/g, '')
                .split(',')
                .map(x => Number(x.trim()))
                .filter(n => !isNaN(n) && n > 0);
        }
    }
    // Deduplicate
    errorListeners = Array.from(new Set(errorListeners));
    const modelRaw = getVal('OpenRouterModel') ?? getVal('Model') ?? getVal('openrouter_model');
    const openRouterModel = modelRaw && modelRaw.trim().length > 0 ? modelRaw.trim() : undefined;
    const baseUrlRaw = getVal('OpenRouterBaseUrl') ?? getVal('BaseUrl') ?? getVal('openrouter_base_url');
    const openRouterBaseUrl = baseUrlRaw?.trim() || undefined;
    const proxyRaw = getVal('OpenRouterProxy') ?? getVal('Proxy') ?? getVal('openrouter_proxy');
    // An explicit empty proxy disables an inherited forward proxy.
    const openRouterProxy = proxyRaw === undefined ? undefined : proxyRaw.trim();
    const formatRaw = getVal('PdfFormat') ?? getVal('pdf_format');
    const pdfFormat = formatRaw && formatRaw.trim().length > 0 ? formatRaw.trim().toLowerCase() : undefined;
    return {
        adminId,
        errorListeners,
        maxRequestsPerJob,
        openRouterModel,
        openRouterBaseUrl,
        openRouterProxy,
        pdfFormat,
        raw
    };
}
//# sourceMappingURL=types.js.map