"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sanitizeArticleContent = sanitizeArticleContent;
const sanitize_html_1 = __importDefault(require("sanitize-html"));
function sanitizeArticleContent(rawHtml) {
    if (!rawHtml || typeof rawHtml !== 'string') {
        return '';
    }
    return (0, sanitize_html_1.default)(rawHtml, {
        allowedTags: [
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'p', 'blockquote', 'pre', 'code',
            'ul', 'ol', 'li',
            'a',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
            'hr', 'br',
            'em', 'strong', 'b', 'i', 'u', 's', 'strike', 'del',
            'span', 'sub', 'sup'
        ],
        allowedAttributes: {
            a: ['href', 'title', 'rel', 'target'],
            th: ['colspan', 'rowspan', 'align'],
            td: ['colspan', 'rowspan', 'align']
        },
        allowedSchemes: ['http', 'https'],
        allowedSchemesByTag: {
            a: ['http', 'https']
        },
        transformTags: {
            a: sanitize_html_1.default.simpleTransform('a', {
                rel: 'noopener noreferrer',
                target: '_blank'
            })
        },
        // Completely drop disallowed tags including their contents for dangerous elements
        exclusiveFilter: (frame) => {
            return ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select'].includes(frame.tag);
        }
    });
}
//# sourceMappingURL=sanitizer.js.map