/**
 * AWS Lambda Reverse Proxy for OpenRouter and Telegram APIs
 * Defaults to OpenRouter; destination=telegram selects the Telegram Bot API.
 */
export const PROXY_VERSION = '1.0.35';

export async function handler(event) {
  const query = new URLSearchParams(event.rawQueryString ?? new URLSearchParams(event.queryStringParameters || {}).toString());
  const destinations = query.getAll('destination');
  const destination = destinations.length === 0 ? 'openrouter' : destinations[0];
  const upstreams = new Map([
    ['openrouter', 'https://openrouter.ai'],
    ['telegram', 'https://api.telegram.org'],
  ]);
  if (destinations.length > 1 || !upstreams.has(destination)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid destination; use openrouter or telegram' }),
    };
  }
  query.delete('destination');

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

  if (method === 'GET' && query.has('version')) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ service: 'aws-reverse-proxy', version: PROXY_VERSION }),
      isBase64Encoded: false,
    };
  }

  try {
    const rawPath = event.rawPath || event.path || '/';
    const targetUrl = new URL(upstreams.get(destination));
    // Assign the path rather than resolving it: //host and absolute URLs cannot change the origin.
    targetUrl.pathname = rawPath;
    targetUrl.search = query.toString();

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
      redirect: 'error'
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
  } catch {
    // Raw fetch exceptions can include Telegram tokens in request paths.
    console.error('Proxy request failed', { destination, category: 'upstream_request_failed' });
    return {
      statusCode: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        error: 'Proxy Bad Gateway',
        message: 'Upstream request failed'
      })
    };
  }
}
