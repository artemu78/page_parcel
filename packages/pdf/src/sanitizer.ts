import sanitizeHtml from 'sanitize-html';

export function sanitizeArticleContent(rawHtml: string): string {
  if (!rawHtml || typeof rawHtml !== 'string') {
    return '';
  }

  return sanitizeHtml(rawHtml, {
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
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer',
        target: '_blank'
      })
    },
    // Completely drop disallowed tags including their contents for dangerous elements
    exclusiveFilter: (frame) => {
      return ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select'].includes(
        frame.tag
      );
    }
  });
}
