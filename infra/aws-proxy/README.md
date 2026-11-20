# AWS Lambda Reverse Proxy for OpenRouter and Telegram

This serverless function acts as a dedicated reverse proxy forwarding requests to `https://openrouter.ai`.

Because it runs on AWS Lambda (outside Russia) and uses standard AWS egress IP addresses, it bypasses Cloudflare WAF geo-blocking without forwarding client headers.

---

## Deployment via AWS SAM

### 1. Build and Deploy

From the repository root or from `infra/aws-proxy`:

```bash
cd infra/aws-proxy
sam build
sam deploy --guided
```

When prompted by `sam deploy --guided`:
- **Stack Name**: `openrouter-proxy` (or your preferred name)
- **AWS Region**: `us-east-1` (or `eu-central-1`)
- **Confirm changes before deploy**: `y` (or `n`)
- **Allow SAM CLI IAM role creation**: `y`
- **Disable rollback**: `n`
- **OpenRouterProxyFunction Function Url has no authentication. Is this okay?**: `y`
- **Save arguments to configuration file**: `y`

After deployment, SAM will output the public **Function URL**:
```text
Outputs:
ProxyFunctionUrl: https://xxxxxxxxxxxxxxxxxxxx.lambda-url.us-east-1.on.aws/
```

---

## 2. Test the Proxy

Test the deployed function URL:

```bash
# Test auth endpoint:
curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  https://YOUR-FUNCTION-URL.lambda-url.us-east-1.on.aws/api/v1/auth/key

# Test chat completions:
curl -s -X POST https://YOUR-FUNCTION-URL.lambda-url.us-east-1.on.aws/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"Hi"}]}'
```

---

## 3. Update YDB Settings

Set the proxy URL as the `BaseUrl` in the YDB `Settings` table:

```bash
npx tsx -e "
import { YdbJobStore } from '../../packages/jobs/src/ydb-store.js';
import path from 'path';

process.env.YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS = path.resolve('../../infra/yandex/authorized_key.json');
const store = new YdbJobStore({
  endpoint: 'grpcs://ydb.serverless.yandexcloud.net:2135',
  database: '/ru-central1/b1g2vhk5e81ojfubiddd/etn8q0fueuk64196c78h'
});
await store.init();
await store.setSetting('BaseUrl', 'https://YOUR-FUNCTION-URL.lambda-url.us-east-1.on.aws/api/v1');
console.log('Saved BaseUrl to Settings table');
await store.destroy();
"
```


The webhook reads `BaseUrl` (or `OpenRouterBaseUrl`) from runtime settings for each
AI completion, subject to the 15-second settings cache. Include `/api/v1` in the
value. This Lambda endpoint is a reverse proxy; `Proxy`/`OpenRouterProxy` instead
configures a separate forward HTTP proxy and should not contain the Lambda URL.
See [routing diagnostics](../../docs/operations.md#openrouter-routing-and-diagnostics)
for safe log fields and the intentional absence of GitHub issues for HTTP 403.

## Destination routing

The deployed endpoint is an API Gateway URL (`ProxyApiUrl`), not a Lambda Function URL.
No `destination` parameter preserves the OpenRouter route. Explicit
`destination=openrouter` selects `https://openrouter.ai`; `destination=telegram`
selects `https://api.telegram.org`. Unknown, empty, or repeated destination values
return HTTP 400. The selector is removed before forwarding other query parameters.
Method, path, request body, and the existing header filtering are preserved.
Redirects are rejected so requests cannot escape the selected upstream.

Example Telegram request: POST `/bot<TOKEN>/sendMessage?destination=telegram`
with JSON `{"chat_id":"<CHAT_ID>","text":"Hello"}`. Never publish a real token.
Proxy-generated failures return a fixed error and log only the selected destination
and a fixed category; raw errors and upstream URLs are not logged by the handler.
Any API Gateway access logging must also avoid token-bearing paths.

Deploy from this directory with `sam build` followed by `sam deploy`.
Run the isolated proxy tests with `node --test infra/aws-proxy/test/*.test.mjs`
from the repository root.

## Deployed version

GET `/?version` returns `{"service":"aws-reverse-proxy","version":"1.0.35"}`
without calling either upstream. The response disables caching. `?version=1`
is also supported, optionally combined with a valid destination selector.
POST requests continue to be forwarded; OPTIONS keeps its preflight behavior.
The version is packaged in `src/index.mjs` and tested against the root package version;
update both when bumping the proxy version. Redeploy AWS to expose the new version.
