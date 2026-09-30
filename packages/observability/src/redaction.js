"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redactSensitiveData = redactSensitiveData;
exports.sanitizeLogValue = sanitizeLogValue;
const SECRET_PATTERNS = [
    /(?:github_pat_|gh[pousr]_)[a-zA-Z0-9_]+/g,
    /sk-(?:or-v1-)?[a-zA-Z0-9_-]+/g,
    /access_token=[a-zA-Z0-9._-]+/gi,
    /vk1\.a\.[a-zA-Z0-9._-]+/gi,
    /secret=[a-zA-Z0-9._-]+/gi,
    /bearer\s+[a-zA-Z0-9._-]+/gi,
    /upload_url=[^&\s]+/gi,
    /https?:\/\/[^:]+:[^@]+@/gi
];
function redactSensitiveData(input) {
    let result = input;
    // Exact known credentials cover provider errors echoing plain tokens without a prefix.
    for (const [key, value] of Object.entries(process.env)) {
        if (/TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL/i.test(key) && value && value.length >= 8) {
            result = result.split(value).join('[REDACTED]');
        }
    }
    result = result.replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/[?#].*$/, '?[REDACTED]'));
    for (const pattern of SECRET_PATTERNS) {
        result = result.replace(pattern, (match) => {
            if (match.toLowerCase().startsWith('access_token='))
                return 'access_token=[REDACTED]';
            if (match.toLowerCase().startsWith('secret='))
                return 'secret=[REDACTED]';
            if (match.toLowerCase().startsWith('bearer '))
                return 'Bearer [REDACTED]';
            if (match.toLowerCase().startsWith('upload_url='))
                return 'upload_url=[REDACTED]';
            if (match.startsWith('vk1.a.'))
                return 'vk1.a.[REDACTED]';
            return '[REDACTED]';
        });
    }
    return result;
}
function sanitizeLogValue(val) {
    if (typeof val === 'string') {
        return redactSensitiveData(val);
    }
    if (Array.isArray(val)) {
        return val.map(sanitizeLogValue);
    }
    if (val !== null && typeof val === 'object') {
        const sanitized = {};
        for (const [k, v] of Object.entries(val)) {
            if (k.toLowerCase().includes('token') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('password')) {
                sanitized[k] = '[REDACTED]';
            }
            else {
                sanitized[k] = sanitizeLogValue(v);
            }
        }
        return sanitized;
    }
    return val;
}
//# sourceMappingURL=redaction.js.map