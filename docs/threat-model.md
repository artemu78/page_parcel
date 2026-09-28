# Threat Model: Readable Web

## 1. System Overview and Product Purpose
**Readable Web** is a read-only web-to-readable-PDF VK community bot. A user submits `/read <URL>`. The system validates the URL, fetches the public article, extracts readable text and structure, formats it into an offline reader template, renders a PDF via headless Chromium, uploads the PDF to VK Documents, and replies with a native attachment in private VK messages.

It is **NOT** a proxy, VPN, interactive browser, screenshot engine, or general-purpose downloader. It does not bypass paywalls, CAPTCHAs, or authentication, and never uses user credentials or cookies.

---

## 2. Trust Boundaries and Data Flow

```text
[ VK User / Chat ]
       │  (HTTPS - Callback API event: /read <URL>)
       ▼
┌────────────────────────────────────────────────────────┐
│ Ingress Boundary: Webhook (Public Serverless Container)│
│ - Validates VK signature/secret, group_id, payload     │
│ - Parses & prevalidates URL (protocol, port, syntax)   │
│ - Checks atomic per-user rate limit                    │
│ - Persists job state in YDB (accepted)                 │
│ - Enqueues message to Yandex Message Queue (YMQ)       │
└────────────────────────────────────────────────────────┘
       │
       ▼ (YMQ SQS-compatible Queue + DLQ)
┌────────────────────────────────────────────────────────┐
│ Worker Boundary: Worker Orchestrator                   │
│ - Authenticated invocation via IAM Service Account     │
│ - Claims job atomically via lease in YDB               │
│ - Coordinates render, upload, delivery checkpoints     │
└────────────────────────────────────────────────────────┘
       │
       ├─────────────────────────┐
       ▼                         ▼
┌──────────────────────┐   ┌───────────────────────────┐
│ Validating Forward   │   │ Isolated Chromium Engine  │
│ Egress Proxy         │◄──┤ (Non-root, Sandboxed,     │
│ - Socket-level SSRF  │   │ Fresh Context per job,    │
│   verification       │   │ Scripts bounded,          │
│ - DNS rebinding check│   │ No storage/cookies)       │
│ - Streaming size caps│   └─────────────┬─────────────┘
└──────────┬───────────┘                 │
           │ (Sanitized HTML)            │ (PDF Buffer)
           ▼                             ▼
┌──────────────────────┐   ┌───────────────────────────┐
│ Untrusted Web Host   │   │ VK API Client             │
│ (Target Article)     │   │ - docs.getMessagesUpload  │
│                      │   │ - Upload to VK doc server │
│                      │   │ - docs.save               │
│                      │   │ - messages.send           │
└──────────────────────┘   └───────────────────────────┘
```

---

## 3. Threat Analysis & Mitigations

### 3.1 Server-Side Request Forgery (SSRF) and Cloud Metadata Access
* **Threat:** Attackers submit URLs targeting cloud metadata (`169.254.169.254`), container localhost (`127.0.0.1`), VPC private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, loopback, or DNS rebinding targets to steal IAM tokens or scan internal infrastructure.
* **Mitigations:**
  1. **Strict URL Prevalidation:** Only `http` and `https` schemes; strictly ports `80` and `443`; reject credentials in URL (`user:pass@host`).
  2. **Socket-Level Validating Egress Proxy:** DNS prevalidation alone is vulnerable to TOCTOU / DNS rebinding and redirect tricks. All browser outbound traffic MUST pass through an egress proxy. The proxy resolves DNS at connection time, inspects every resolved IP against an exhaustive IP blocklist (IPv4, IPv6, IPv4-mapped IPv6, CGNAT, loopback, link-local, multicast, cloud metadata), and binds the outbound TCP socket strictly to a validated IP while preserving the original Host header and TLS validation.
  3. **Redirect Revalidation:** Redirect targets (`Location` headers) are intercepted before connection and subject to the exact same validation rules.
  4. **Strict Isolation of Trusted APIs:** Untrusted browser requests can never reach internal networks, VK API endpoints, or Yandex Cloud metadata.

### 3.2 Hostile Pages & Browser Exploitation
* **Threat:** Malicious web pages exploiting Chromium vulnerabilities (V8, WebKit/Blink engine flaws), memory corruption, or running infinite loops to compromise the host.
* **Mitigations:**
  1. **Chromium Sandbox:** Chromium must run with sandboxing enabled (`--no-sandbox` prohibited in production).
  2. **Least Privilege Process:** Runs as an unprivileged user (`pwuser` / UID 10001) with no root capabilities.
  3. **Clean Context Isolation:** Every job gets a completely fresh browser context (`browser.newContext()`) with cookies, storage, cache, and service workers disabled. Browser contexts are closed immediately on job completion or failure.
  4. **Feature & Request Blocking:** Service workers, WebSockets, WebRTC, Geolocation, Notifications, Popups, and Download managers are disabled.
  5. **Resource Blocking:** External fonts, audio, video, images, ads, and trackers are blocked via Playwright routing to minimize attack surface and resource usage.
  6. **Process Recycling:** Browser processes are killed and recycled if any timeout, deadline violation, crash, or memory spike occurs.

### 3.3 Resource Exhaustion and Denial of Service (DoS)
* **Threat:**
  - Decompression bombs (gzip/brotli bombs).
  - Infinite streaming responses or hanging TCP connections.
  - Runaway DOM / massive HTML pages designed to exhaust worker RAM.
  - Spammed `/read` requests overwhelming worker queues.
* **Mitigations:**
  1. **Streaming Byte Budget:** Responses are inspected as a stream at the proxy layer. Single response limit: 5 MiB decoded. Aggregate job response limit: 20 MiB decoded. If exceeded, the connection is instantly aborted with an error.
  2. **Bounded Request Count:** Maximum 100 HTTP resource requests per job.
  3. **Strict Timeouts:**
     - Webhook acknowledgment deadline: < 3 seconds.
     - DNS resolution timeout: 3 seconds.
     - Page navigation timeout: 30 seconds (`domcontentloaded`).
     - Total rendering deadline: 60 seconds.
     - Total whole-job worker deadline: 120 seconds.
  4. **Concurrency & Rate Limiting:**
     - Atomic per-user rate limit (1 active job per user, sliding window quota).
     - Worker instance concurrency: strictly 1 active browser job per worker instance.
     - Global queue concurrency cap governed by YMQ trigger scaling limits.

### 3.4 Untrusted Content in PDF Generation (HTML/XSS Injection)
* **Threat:** Extracted article content containing malicious JavaScript, `<iframe>` embeds, `<object>` tags, or CSS exfiltration payloads executing during PDF generation.
* **Mitigations:**
  1. **Strict HTML Sanitization:** Content passed to the reader template is filtered with `sanitize-html` against a strict allowlist (`p, h1-h6, blockquote, pre, code, ul, ol, li, a, table, thead, tbody, tr, th, td, hr, br, em, strong`).
  2. **No Dynamic Execution during PDF print:** The reader template is rendered in a Chromium context where **JavaScript is completely disabled** (`javaScriptEnabled: false`) and network access is disabled (`offline: true`).
  3. **No External Assets in PDF:** All styles and fonts in the reader template are self-contained and bundled. No remote images or remote fonts are loaded.
  4. **Safe Filename Generation:** Filenames for VK upload are synthesized (`article-<jobId>.pdf`), never derived from user input or remote `Content-Disposition`.

### 3.5 Credentials and Sensitive Data
* **Threat:** Accidental leakage of VK community token, Callback API secret, or Yandex Cloud credentials into logs, error messages to users, or browser processes.
* **Mitigations:**
  1. **Process Separation:** Browser context environment does not inherit application secrets.
  2. **Log Redaction:** Token parameters, signed upload URLs, and authorization headers are scrubbed before logging.
  3. **Opaque Error Messages:** User-facing error messages contain only a safe high-level failure category and the job ID for tracking. Stack traces and internal IPs are never sent to users.
  4. **Managed Secret Storage:** Secrets loaded from Yandex Lockbox / environment at container startup; never checked into version control.

### 3.6 Duplicate Processing and Replay Attacks
* **Threat:** VK Callback API retries on transient network timeouts, causing multiple workers to render and deliver duplicates, draining quotas and API limits.
* **Mitigations:**
  1. **Idempotent Acceptance:** Webhook uses the documented VK `event_id` or `message.id` as an idempotency key in YDB. Duplicate events return `"ok"` immediately without re-enqueuing.
  2. **Job State Machine & Atomic Leases:** Workers acquire jobs with atomic conditional updates (lease expiry, fencing token). If a worker crashes, the lease expires and another worker can claim it.
  3. **Attachment Checkpointing:** If a worker successfully uploads the document to VK but crashes before sending the message, the retry reuses the stored `vkAttachment` reference instead of re-rendering and re-uploading.
  4. **Stable VK `random_id`:** Outgoing messages use deterministic `random_id` based on job ID and message phase (prepare / success / fail) to guarantee VK-side deduplication.

### 3.7 Privacy and Data Retention
* **Threat:** Residual user reading history, URLs, or generated PDFs lingering on disks or databases indefinitely.
* **Mitigations:**
  1. **No Disk Persistence:** PDF buffers reside only in ephemeral memory/tmp storage during upload and are unlinked immediately after transmission.
  2. **Short TTL:** Job metadata in YDB has a strict 24-hour TTL.
  3. **No Query String Logging:** URLs in logs are redacted to hostnames or replaced by opaque Job IDs.
  4. **Clarified Boundaries:** Users are informed that PDFs delivered to VK are subject to VK's document storage policies.
