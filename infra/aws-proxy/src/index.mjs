/**
 * AWS Lambda Reverse Proxy for OpenRouter API
 * Forwards requests to https://openrouter.ai and returns the response.
 */
export async function handler(event) {
  // Handle CORS preflight requests
  const method = (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, HTTP-Referer, X-Title, User-Agent',
      }
    };
  }

  try {
    const rawPath = event.rawPath || event.path || '/';
    const queryString = event.rawQueryString || '';
    const targetUrl = new URL(rawPath + (queryString ? `?${queryString}` : ''), 'https://openrouter.ai');

    // Filter incoming headers to forward
    const forwardHeaders = {};
    const excludedHeaders = new Set([
      'host',
      'connection',
      'content-length',
      'x-amzn-trace-id',
      'x-forwarded-for',
      'x-forwarded-port',
      'x-forwarded-proto',
      'via',
      'expect'
    ]);

    for (const [key, value] of Object.entries(event.headers || {})) {
      const lower = key.toLowerCase();
      if (!excludedHeaders.has(lower) && !lower.startsWith('x-amz-')) {
        forwardHeaders[lower] = value;
      }
    }

    // Set custom/clean User-Agent if none or generic
    if (!forwardHeaders['user-agent']) {
      forwardHeaders['user-agent'] = 'ReadableWeb-Proxy/1.0';
    }

    // Prepare body
    let body = undefined;
    if (method !== 'GET' && method !== 'HEAD' && event.body) {
      body = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : event.body;
    }

    const response = await fetch(targetUrl.toString(), {
      method,
      headers: forwardHeaders,
      body,
      redirect: 'follow'
    });

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*'
    };

    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(lower)) {
        responseHeaders[key] = value;
      }
    });

    const contentType = response.headers.get('content-type') || '';
    const isBinary = !contentType.includes('json') && !contentType.includes('text') && !contentType.includes('xml');

    if (isBinary) {
      const arrayBuffer = await response.arrayBuffer();
      return {
        statusCode: response.status,
        headers: responseHeaders,
        body: Buffer.from(arrayBuffer).toString('base64'),
        isBase64Encoded: true
      };
    }

    const text = await response.text();
    return {
      statusCode: response.status,
      headers: responseHeaders,
      body: text,
      isBase64Encoded: false
    };
  } catch (err) {
    console.error('Proxy request failed:', err);
    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Proxy Bad Gateway',
        message: err.message
      })
    };
  }
}
