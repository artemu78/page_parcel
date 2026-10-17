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
      'hr', 'br', 'img', 'figure', 'figcaption',
      'em', 'strong', 'b', 'i', 'u', 's', 'strike', 'del',
      'span', 'sub', 'sup'
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel', 'target'],
      img: ['src', 'alt', 'title'],
      th: ['colspan', 'rowspan', 'align'],
      td: ['colspan', 'rowspan', 'align']
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesByTag: {
      a: ['http', 'https'],
      img: ['data']
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', {
        rel: 'noopener noreferrer',
        target: '_blank'
      })
    },
    // Completely drop disallowed tags including their contents for dangerous elements
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') return !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.attribs.src || '') || (frame.attribs.src || '').length > 2800000;
      return ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select'].includes(
        frame.tag
      );
    }
  });
}
