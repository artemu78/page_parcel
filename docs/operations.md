# Operations Guide: Readable Web

## 1. Runtime Configuration & Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | No | `production` | Environment mode (`production`, `development`, `test`) |
| `PORT` | No | `8080` (webhook), `8081` (worker) | HTTP port for service |
| `VK_GROUP_ID` | Yes | - | Numeric ID of the VK community |
| `VK_GROUP_TOKEN` | Yes | - | VK API Community Access Token (messages, docs permissions) |
| `VK_SECRET` | Yes | - | Callback API secret string configured in VK community settings |
| `VK_CONFIRMATION_CODE`| Yes | - | String returned for Callback API `confirmation` event |
| `YDB_ENDPOINT` | No | - | YDB endpoint (e.g. `grpcs://ydb.serverless.yandexcloud.net:2135/?database=...`) |
| `YDB_DATABASE` | No | - | YDB database path |
| `YMQ_QUEUE_URL` | Yes | - | Yandex Message Queue URL for jobs |
| `YMQ_DLQ_URL` | No | - | Yandex Message Queue Dead Letter Queue URL |
| `AWS_REGION` | No | `ru-central1` | Region for YMQ (SQS client) |
| `EGRESS_PROXY_PORT` | No | `8050` | Port for internal validating forward egress proxy |
| `MAX_RENDER_DEADLINE_MS` | No | `60000` | Rendering timeout (ms) |
| `MAX_JOB_DEADLINE_MS` | No | `120000` | Whole-job worker timeout (ms) |
| `JOB_TTL_SECONDS` | No | `86400` | Metadata TTL in YDB (24 hours) |

---

## 2. Job Lifecycle & Queue Operations

### 2.1 State Transitions and Retries
* **Normal Flow:** `accepted` ➔ `queued` ➔ `rendering` ➔ `uploading` ➔ `delivering` ➔ `completed`.
* **Permanent / Input Failures:** If a URL is invalid, points to an internal/private IP, fails content extraction (e.g. empty page / paywall), or exceeds size limits, the worker marks the job as `failed` with a categorized reason code (`SSRF_BLOCKED`, `CONTENT_UNSUPPORTED`, `SIZE_EXCEEDED`). It notifies the user and acknowledges the queue message (HTTP 200) to prevent useless retries.
* **Transient / Infrastructure Failures:** If an upstream network timeout occurs or VK API returns a 5xx error:
  - If `attempts < MAX_ATTEMPTS` (default 3): the worker throws an error or returns HTTP 500, causing YMQ to release the message back to the queue after the visibility timeout (with exponential backoff and jitter).
  - If `attempts >= MAX_ATTEMPTS`: the worker marks the job as `failed` (`RETRIES_EXHAUSTED`), sends a friendly failure message to the user, and confirms completion to YMQ.

### 2.2 Stuck Job Reconciliation & Lease Expiry
* If a worker instance crashes or is killed by OOM mid-render, its lease (`leaseExpiresAt = now + 90s`) will expire.
* When YMQ redelivers the message to another worker instance, the atomic claim query verifies `leaseExpiresAt < now` and grants the lease to the new worker.
* If a job exceeds the whole-job deadline (`MAX_JOB_DEADLINE_MS = 120s`) or expiration timestamp (`expiresAt`), workers reject execution and finalize it as expired.

### 2.3 Dead-Letter Queue (DLQ) Management
* Messages reaching `ApproximateReceiveCount > 3` in YMQ are automatically routed to the configured DLQ.
* **Alerting:** Set an alert on `YMQ.QueueMessagesCount{queue="readable-web-dlq"} > 0`.
* **Inspection:** Use AWS CLI / Yandex CLI to view messages in DLQ:
  ```bash
  yc message-queue receive-message --queue-url "$YMQ_DLQ_URL"
  ```
* **Redrive:** After fixing underlying network or service issues, redrive messages back to the primary queue using standard SQS redrive.

---

## 3. Secret Rotation Procedure

### 3.1 VK Callback API Secret (`VK_SECRET`)
1. In the VK Community settings under **Manage > API Usage > Callback API**, generate a new secret string.
2. Update the secret in Yandex Lockbox:
   ```bash
   yc lockbox secret add-version --id <secret-id> --payload-entries vk_secret="<new-secret>"
   ```
3. Deploy new revisions of the Serverless Container.
4. Update the secret field in VK Community settings.

### 3.2 VK Community Access Token (`VK_GROUP_TOKEN`)
1. In VK Community settings, create a new access token with `messages` and `docs` permissions.
2. Add new version in Yandex Lockbox.
3. Apply Terraform to deploy new revisions of both the webhook and worker containers: both receive `VK_GROUP_TOKEN` from the current Lockbox version. Confirm both revisions use the new token before revoking the old one.
4. Revoke the old token in VK settings.

---

## 4. Resource Limits & Sizing Guidelines

* **Webhook Container:**
  - Memory: 256 MiB.
  - vCPU: 0.25.
  - Timeout: 3s.
  - Concurrency: 50.
* **Worker & Renderer:**
  - Memory: 2048 MiB (Playwright Chromium requires sufficient headroom for rendering complex pages).
  - vCPU: 2.0.
  - Timeout: 120s.
  - Concurrency: strictly 1 browser render per worker instance to ensure memory predictability.
* **Limits Enforced in Code:**
  - Max redirects: 5.
  - Max subresources per job: 100.
  - Max decoded size per response: 5 MiB.
  - Max aggregate decoded size per job: 20 MiB.
  - Max PDF file size: 10 MiB.

---

## 5. Privacy, Purging, and Data Cleanup

1. **Local Ephemeral Storage:**
   - Temporary PDFs are stored in memory or `/tmp` using unique filenames (`article-<jobId>.pdf`).
   - Temporary files are explicitly unlinked in `finally` blocks upon completion or failure.
2. **Database TTL:**
   - The `jobs` table in YDB is configured with automatic TTL of 86400 seconds (24 hours) based on `createdAt`.
   - Application queries additionally filter out any jobs where `now > expiresAt`.
3. **VK Document Storage:**
   - Documents uploaded to VK via `docs.save` belong to the community and message thread.
   - Deleting temporary container data does not delete the VK document attachment from VK's infrastructure.

## 6. GitHub runtime bug reporting

Both services require `GITHUB_TOKEN` and `GITHUB_REPOSITORY` in production. Terraform
injects the Lockbox entry `github_token` as `GITHUB_TOKEN` into **both** containers,
using the same secret/version mechanism as `openrouter_api_key`. The repository is
configured through `github_repository` (default `artemu78/page_parcel`). Add the
entry to the selected secret version before deploying. Keep existing VK and
OpenRouter entries in that version. Do not put token values in Terraform variables
or state. Use a fine-grained token scoped to the target repository with Issues
read/write permission, enable issues, and ensure the `bug` label exists.
See [GitHub issue creation](https://docs.github.com/en/rest/issues/issues#create-an-issue)
and [container secret configuration](https://registry.terraform.io/providers/yandex-cloud/yandex/latest/docs/resources/serverless_container#secrets).

Code exceptions use `Logger.exception(error, 'Fixed operation label', context)`.
Pass the original exception object; do not interpolate private data in the operation
label. The same exception object propagated through several catches is reported
once per process. Each distinct exception occurrence creates an issue with the
`bug` label. Caught internal failures, best-effort settings/cleanup/extraction
failures, startup failures, uncaught exceptions, and unhandled rejections use this
path. Log filtering does not suppress reporting. Expected input validation,
security-policy rejection, and parser probes for supported input formats remain
ordinary operational events rather than code bugs.

`UpstreamResponseError` represents a received third-party failure response. VK
HTTP/API errors, OpenRouter non-2xx responses, article HTTP failures, and SDK errors
carrying `$metadata.httpStatusCode` are logged at **Info**, including at enclosing
catch boundaries, and do not create bug issues. HTTP statuses are logged without
response bodies, prompts, authorization headers, or signed upload URLs. Existing
job retry/failure decisions and VK ErrorListener delivery remain in place.

With YDB configured, startup creates `exception_reports`, independently of the job
state machine. Reports are persisted before delivery, claimed in batches of 10
under a five-minute lease using a serializable transaction, and removed after
GitHub confirms creation (or an existing issue with the report marker is found).
Both services retry pending reports every 30 seconds and flush at processing and
shutdown boundaries. HTTP calls have five-second timeouts; a drain stops starting
new calls after 60 seconds. Fatal process errors get a 15-second grace period before
exit. Reporter failures are warnings and never recursively create more issues.
Monitor `Exception report pending; delivery will retry` and the table backlog.
Pending reports have no TTL and require recovery/cleanup if token access is revoked.

Issue bodies include the deployed `APP_VERSION` (or an explicit unknown marker),
fixed operation labels, safe correlation fields, timestamps, code filenames/line
numbers, and the exception message. Multiline diagnostics are preserved, with
credential redaction and URL removal before persistence or GitHub delivery. Error
text is limited to 12,000 characters with an explicit truncation marker; Markdown
fences in the message are kept inside its code block. Additional request payloads
and arbitrary exception properties are not exported. Error messages can themselves
contain application data, so avoid embedding private payloads in exceptions;
redaction is not a guarantee of removing every kind of personal data. Pending
reports preserve the version and text from capture time. Existing issues and
previously stored report bodies are not retroactively changed. GitHub issues have
the repository's visibility and retention; remove them there when required.

Delivery is best effort before the outbox is initialized, without YDB (local mode),
or while YDB is unavailable. A hard kill/OOM before persistence cannot be reported
by process hooks. GitHub does not offer an idempotency key for issue creation:
a stable report marker and paginated issue lookup reduce duplicates after an
ambiguous POST, but do not give an exactly-once guarantee. Lookup stops after ten
pages of issues updated since the capture time (with a one-minute clock margin),
retaining the report for retry rather than creating a possible duplicate. No live
YDB/GitHub delivery is implied by mocked tests; verify a controlled exception after
deployment with the configured token.

## 7. Serper search

In search mode, ordinary non-command text (up to 500 characters) searches Google via the third-party
Serper API (`POST https://google.serper.dev/search`, `num: 20`, `hl: ru`).
Set `SERPER_API_KEY` locally, or add `serper_api_key` to the selected Lockbox secret
version for deployment; Terraform injects it into the webhook only. Keep all
existing secret entries. Obtain the key at https://serper.dev/ and never commit it.
Missing credentials, exhausted credits, HTTP failures and unsupported JSON produce
a temporary unavailable notice. One provider request returns up to 20 organic
results; pagination makes no further API calls. Requests have an eight-second
timeout and a one-MiB decoded response limit. Links pass existing public URL checks
and the full safe fetching pipeline when selected for PDF.

Configure the community's greeting text to show the following before a user's
first message, and enable the `message_allow` callback if greeting on permission
is desired:

> Привет! Я ищу веб-страницы и помогаю читать их во ВКонтакте. Напишите, что ищете, — я предложу ссылки. Выберите страницу кнопкой, и я пришлю её PDF-версию.

The application sends this greeting for `/start`, «Начать», start-button payloads,
the first observed free-text query, and message permission callbacks. Opening a dialog
alone does not emit a callback. Set up VK's community greeting for that case.
Private dialogs only are supported. Blocked users cannot search or page results.

Webhook startup creates two tables (and fails startup if they cannot be initialized):

- `search_queries`: `id Utf8` primary key (hash of owner, peer, callback event),
  `owner_id Int64`, `created_at Timestamp`, `data Utf8`. JSON data contains query,
  peer, status (`pending`, `completed`, `failed`) and cached titles, URLs and snippets.
  Native TTL on `created_at` is 24 hours; the application rejects expired rows
  even before physical TTL deletion. This logs accepted searches, including
  provider failures; rejected over-limit attempts are not query-log entries.
- `search_limits`: `owner_id Int64` primary key, `last_at Int64` (epoch milliseconds).
  Contains only the latest accepted search time; no query text.

One serializable YDB transaction checks event deduplication and the per-user
30-second cooldown, then writes both tables. Conditional writes select from a
one-row `AS_TABLE` source: YQL rejects `SELECT ... WHERE` without `FROM`
with `Filtering is not allowed without FROM`. PDF job limits are separate.
Seven cached results are sent per message; button payloads dispatch `/read URL` (long URLs use an owner-checked cached result index to stay within VK payload limits).
«Ещё» contains the search ID and explicit offset, has no search limit, and does
not contact Serper. Access checks bind cached results to owner and private peer.
Duplicate search callbacks do not repeat the provider call. A process interruption
after admission can leave a pending search until TTL; the user can submit a fresh
query after cooldown. VK replies retain the existing best-effort delivery behavior.

Queries are personal data: they are sent to Serper, cached in YDB for 24 hours,
and delivered through VK. Query text and search result content are excluded from
application logs and GitHub bug reports. Restrict YDB access accordingly. Local
mode uses memory, so logs, cooldowns and results reset on restart.

No live provider, VK delivery, or YDB provisioning success is implied by mocked
tests. Verify all three in the target environment before deployment acceptance.

Serper integration is tested with mocked JSON responses, including authentication,
quota failures, malformed responses, result filtering and cached pagination.
Successful live Serper search requires a configured key and remains unverified.
No cloud deployment was performed.

## 8. Chat modes

Persistent text buttons select `search` (default) or `ai`; selected buttons use a
checkmark and primary color. AI mode also offers «Новый разговор». Inline PDF,
status and pagination buttons continue to operate independently of the selected
mode. Replies carry search/AI headings. VK bot keyboards must be enabled in the
community; error 912 falls back to text, so the visual switch is unavailable until
the community setting is fixed.

Webhook startup initializes `conversations` (`owner_id Int64` primary key,
`version Int64`, `data Utf8`). JSON contains mode, bounded context, up to 100 recent
mode/free-text event hashes, and a pending AI reservation. Serializable version-checked
writes avoid lost updates across instances. Mode survives restart in YDB; local
memory mode resets on restart. This table has no native TTL: context older than
24 hours is excluded from prompts and cleared on the next successful mutation,
but an idle row can retain that data until then. Restrict database access.

AI is available to all enabled users when `OPENROUTER_API_KEY` is configured
(`openrouter_api_key` in the deployed Lockbox secret). Missing credentials produce
an unavailable notice without silently searching. The `Model`/`OpenRouterModel`
setting chooses the model. Base URL and forward proxy also use runtime settings; see the routing rules below.
AI mode has no web-search tools. Prompts and recent replies go to OpenRouter and
its selected provider, and replies go to VK; provider retention is independent of
local context expiry. Do not log or report conversation content.

Input is limited to 4000 characters; context to 12 recent user/assistant pairs and
24000 characters. Generation requests use `max_tokens: 2000`, and replies are
split into chunks below 4000 characters, each marked «💬 Ответ ИИ». AI requests
share the existing per-user minute quota with PDF requests; search keeps its own
30-second cooldown. One AI request per user can be pending for 90 seconds.
Duplicate accepted AI events within the last 100 mode/free-text events do not call the
provider again. Reset clears pending state, fencing late replies; changing mode
preserves context and does not let a pending reply overwrite the selected mode.

Replies remain best-effort: a process interruption after reservation can lose a
reply, and duplicate callbacks are not a durable delivery retry mechanism. After
90 seconds a fresh prompt can acquire a new reservation. Old event hashes beyond
the bounded deduplication window may be accepted again. Live VK, OpenRouter and
YDB behavior must be verified separately from the mocked tests.

### OpenRouter routing and diagnostics

Every AI completion passes the parsed model, base URL and forward proxy from
`JobStore.getSettings()` to the client. Keys are case-insensitive. Priority:

- Base URL: `OpenRouterBaseUrl`, `BaseUrl`, `openrouter_base_url`, then client/environment
  `OPENROUTER_BASE_URL`, then `https://openrouter.ai/api/v1`. Blank database base URLs
  use the client fallback. The client appends `/chat/completions`.
- Forward proxy: `OpenRouterProxy`, `Proxy`, `openrouter_proxy`, then client/environment
  `OPENROUTER_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy`.
  An explicitly empty database proxy value disables the inherited forward proxy.
- Model: `OpenRouterModel`, `Model`, `openrouter_model`, then the client default.

Use the deployed AWS Lambda Function URL plus `/api/v1` as `BaseUrl`. This is a
reverse proxy endpoint, not a CONNECT forward proxy: do not put a Lambda URL in
`Proxy`. The existing client skips forward proxying for loopback targets.
YDB settings are cached for 15 seconds; do not assume a change is immediate.
Preserve these settings when editing chat routing. See the [AWS proxy guide](../infra/aws-proxy/README.md).

`OpenRouter request` and `OpenRouter HTTP response` include `destinationHost`,
`routing` (`direct` for `openrouter.ai`, otherwise `reverse_proxy`), `model`,
`forwardProxyUsed`, optional `forwardProxyHost`, and a generated `openRouterRequestId`.
Routing is a description of the configured hostname, not proof of actual AWS egress.
Response logs include status, a format indicator, and optional validated
`upstreamRequestId` (`x-request-id`/`request-id`) and `cloudflareRay` (`cf-ray`).
These provider IDs are distinct from the cloud webhook request ID.

Failed HTTP responses additionally log `responseBytes`, `durationMs`, a fixed
`failureCategory`, and numeric `providerErrorCode` when present. Categories classify
known message patterns into geography, authentication, credits, rate limits,
content policy or model availability; unrecognized/HTML errors remain
`upstream_rejection`. A 403 alone does not establish a geography restriction.
Malformed completions and oversized bodies have their own fixed categories.
Responses are capped at one MiB; upstream rejections remain Info-level
`UpstreamResponseError` events and intentionally do not create GitHub issues.
Actual code exceptions still use `Logger.exception` and the existing reporter.

Do not log raw provider error messages or metadata: responses can echo prompts or
contain flagged input and rejected completions. Diagnostics exclude full URLs,
URL credentials/path/query, tokens, request headers, prompts, history, completions,
and raw JSON/HTML bodies. Do not add these fields to GitHub reports. Verify routing
with the hostname and flags first, then inspect the safe status/category and
provider IDs. These logs do not by themselves prove the deployed proxy works;
live cloud/provider verification is separate from mocked and local HTTP tests.

## Container build caching

Both Dockerfiles copy root and workspace dependency manifests into a separate
stage before installing dependencies. Source-only changes reuse dependency
installation; the worker also reuses its browser installation layer. When adding
a workspace, add its package manifest COPY to both Dockerfiles.

BuildKit cache mounts retain npm downloads and apt metadata/packages on the
builder, outside the final image. Debian's automatic apt archive cleanup is
disabled so those downloads can be reused. First builds still need downloads;
cache pruning or switching builders removes the benefit. Base-image updates
still rebuild dependent layers. Keep refreshing the base image and dependencies
for security updates.

The worker installs only Chromium's headless shell, matching both current
headless launches without a browser channel. A future headed launch or explicit
Chromium channel requires revisiting that installation.
