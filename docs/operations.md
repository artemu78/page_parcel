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
3. Deploy new revisions of the worker container.
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
