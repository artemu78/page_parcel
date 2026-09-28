# Architecture: Readable Web

## 1. System Overview

**Readable Web** is a production-minded TypeScript/Node.js service that processes user commands from VK Messenger, downloads public web articles, creates clean, reader-style PDFs, and delivers them back as native VK document attachments.

```text
┌─────────────────┐       HTTPS       ┌──────────────────────────────────────────────┐
│  VK Messenger   ├──────────────────►│             Webhook App                      │
│  (Callback API) │◄──────────────────┤  (Yandex Serverless Container / Express)     │
└─────────────────┘      "ok" /       └──────────────────────┬───────────────────────┘
                      confirmation                           │
                                                             │ 1. Deduplicate & Save State
                                                             │ 2. Enqueue Job
                                                             ▼
                                      ┌──────────────────────────────────────────────┐
                                      │ YDB (Managed Database)                       │
                                      │ - jobs table (TTL 24h, state, version, lease)│
                                      │ - rate_limits table (per-user atomic limits) │
                                      └──────────────────────┬───────────────────────┘
                                                             │
                                                             ▼
                                      ┌──────────────────────────────────────────────┐
                                      │ Yandex Message Queue (YMQ)                   │
                                      │ SQS-compatible Queue + Dead Letter Queue     │
                                      └──────────────────────┬───────────────────────┘
                                                             │
                                                             │ YMQ Trigger (batch size 1)
                                                             ▼
                                      ┌──────────────────────────────────────────────┐
                                      │             Worker App                       │
                                      │ - Claim lease in YDB (atomic)                │
                                      │ - Update status: rendering                   │
                                      └──────────────┬───────────────────────────────┘
                                                     │
                             ┌───────────────────────┴───────────────────────┐
                             │                                               │
                             ▼                                               ▼
┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ Safe Network: Validating Egress Proxy        │  │ Browser Engine: Playwright (Chromium)    │
│ - Socket-level SSRF filter & IP blocklist    │◄─┤ - Fresh context per job                  │
│ - DNS resolution & rebinding defense         │  │ - Service workers / media / fonts blocked│
│ - Streaming response byte limiter (5 MiB/20M)│  │ - HTML Readability extraction            │
└──────────────────────┬───────────────────────┘  └──────────────────┬───────────────────────┘
                       │                                             │
                       ▼                                             ▼
┌──────────────────────────────────────────────┐  ┌──────────────────────────────────────────┐
│ Public Web Target Article                    │  │ PDF Generator (Sanitized Offline HTML)   │
└──────────────────────────────────────────────┘  └──────────────────┬───────────────────────┘
                                                                     │
                                                                     │ Buffer in ephemeral memory
                                                                     ▼
                                                  ┌──────────────────────────────────────────┐
                                                  │ VK API Client                            │
                                                  │ 1. docs.getMessagesUploadServer          │
                                                  │ 2. POST multipart/form-data              │
                                                  │ 3. docs.save                             │
                                                  │ 4. Checkpoint attachment in YDB          │
                                                  │ 5. messages.send (doc attachment)        │
                                                  └──────────────────────────────────────────┘
```

---

## 2. Platform Feasibility & Hardened Deployment Evaluation

### 2.1 Chromium Sandboxing on Yandex Serverless Containers
* **Contract Analysis:** Chromium requires Linux user namespaces (`CLONE_NEWUSER`) or SUID sandbox helpers to isolate browser renderers. Serverless container platforms (including Yandex Serverless Containers, AWS Fargate, and Google Cloud Run) enforce strict kernel security profiles (seccomp) that disallow unprivileged `clone(CLONE_NEWUSER)` system calls. Running Chromium directly inside Serverless Containers requires passing the `--no-sandbox` flag.
* **Security Evaluation:** Passing `--no-sandbox` when visiting arbitrary, untrusted public web pages violates core security requirements: a single V8 or Blink vulnerability allows direct remote code execution inside the worker container.
* **Network Isolation Limitations in Serverless Containers:** In Serverless Containers, processes cannot establish iptables/nftables rules to force all outbound socket traffic through a local egress proxy. Any process in the container can theoretically make direct outbound TCP connections if not restricted.
* **Hardened Architecture Recommendation:**
  1. **Webhook Service:** Runs on **Yandex Serverless Containers**. It handles lightweight HTTP ingress, Callback API verification, rate limiting, and YDB/YMQ persistence without running any browser code.
  2. **Worker & Renderer Service:**
     - **Production Architecture:** Deployed on **Yandex Managed Service for Kubernetes (k8s)** or a dedicated **Yandex Compute Cloud VM with Container-Optimized OS**.
     - **Sandbox Configuration:** The host enables unprivileged user namespaces (`sysctl kernel.unprivileged_userns_clone = 1`), allowing Chromium to run with its full sandbox enabled as non-root user `pwuser` (UID 10001).
     - **Egress Network Enforcement:** The container's network namespace or pod egress firewall enforces that all outbound HTTP/HTTPS traffic must route through the local validating forward proxy. Direct outbound connections on ports 80/443 to the open internet are dropped at the packet filter level.
  3. **Local and Standalone Mode:** The worker container includes an internal validating forward proxy and Playwright context configuration that enforces strict socket-level validation and proxying across all operating systems.

---

## 3. Job State Machine & Lifecycle

```text
[VK Event /read]
       │
       ▼
 [ accepted ] ──(Enqueued to YMQ)──► [ queued ]
                                         │
                                         ▼ (Worker claims lease)
                                   [ rendering ]
                                         │
                     ┌───────────────────┴───────────────────┐
                     │ (Extracted & PDF Generated)           │ (Fetch or Parse Failure)
                     ▼                                       ▼
               [ uploading ]                           [ failed (terminal) ]
                     │                                       │
     ┌───────────────┴───────────────┐                       │
     │ (Doc saved to VK)             │ (Network fail)        │
     ▼                               ▼                       │
[ delivering ]                 [ retryable fail ]            │
     │                               │                       │
     │ (messages.send succeeded)     ▼                       ▼
     ▼                         (Re-enqueued/         [ User Notified ]
[ completed ]                   backoff)
```

### 3.1 State Definitions
* **`accepted`**: The command syntax and basic URL checks passed, and the job was durably written to YDB.
* **`queued`**: Successfully published to YMQ.
* **`rendering`**: Worker claimed the atomic lease, launched an isolated browser context, fetched the public page via the validating proxy, extracted the article, and generated the PDF.
* **`uploading`**: PDF is being uploaded to VK Documents via `docs.getMessagesUploadServer` and `docs.save`.
* **`delivering`**: Document attachment is checkpointed in YDB and being sent via `messages.send`.
* **`completed`**: Document message delivered successfully.
* **`failed`**: Job terminated due to non-retryable error (e.g. invalid URL, paywall/empty text, blocked IP) or retry exhaustion.

### 3.2 Leases and Atomic Claims
* Each claim writes:
  - `status = 'rendering'`
  - `leaseOwner = <worker-instance-id>`
  - `leaseExpiresAt = now + 90s`
  - `version = version + 1`
  - `attempts = attempts + 1`
* Conditional update:
  - `WHERE id = :id AND (leaseExpiresAt < :now OR status IN ('accepted', 'queued'))`
* Prevents split-brain worker executions and stale worker overrides.

---

## 4. Component Boundaries & Responsibilities

| Directory | Scope / Responsibility |
| :--- | :--- |
| `apps/webhook` | VK Callback API endpoint, payload verification, command parser (`/read`, `/status`, `/help`), idempotency check, rate-limiting, job persistence, outbox enqueueing. |
| `apps/worker` | YMQ trigger consumer, atomic lease management, orchestration of rendering, upload, delivery checkpoints, and retry/DLQ lifecycle. |
| `packages/jobs` | Job domain models, state machine transitions, `JobStore` interfaces (YDB implementation, in-memory implementation for tests), rate limiting, outbox publisher. |
| `packages/safe-network` | URL parser, comprehensive IP classification (IPv4, IPv6, mapped IPv6, private/link-local/metadata ranges), DNS resolution with timeout, forward validating HTTP/CONNECT egress proxy with streaming byte limit. |
| `packages/rendering` | Isolated Playwright Chromium manager, request interception (blocking fonts/media/ads/websockets), page navigation with timeouts, article extraction (Mozilla Readability + semantic fallback). |
| `packages/pdf` | HTML sanitizer (`sanitize-html`), controlled reader template, offline Chromium PDF generator, safe filename generator. |
| `packages/vk` | VK Callback API signature and event types, official VK REST API client (`docs.getMessagesUploadServer`, multipart upload, `docs.save`, `messages.send`) with stable `random_id` and token redaction. |
| `packages/observability` | Structured logger with automatic token/URL redaction, Prometheus metrics collector with bounded enum labels. |
| `infra/yandex` | Terraform configurations for Serverless Containers, YMQ + DLQ, YMQ Trigger, YDB Serverless, Lockbox, and IAM service accounts. |
| `infra/containers` | Hardened multi-stage Dockerfiles with non-root user (`pwuser`), pinned dependencies, and bundled fonts. |

---

## 5. Security & Isolation Controls Summary

1. **Strict SSRF Defense:** Validation enforced at connection time by an egress proxy. DNS rebinding and redirect tricks cannot reach non-public or cloud metadata IPs.
2. **Untrusted Page Isolation:** Chromium runs sandboxed, without access to host secrets or filesystem. JavaScript is bounded, service workers are blocked, and storage is ephemeral.
3. **No Dynamic Execution in PDF Template:** Generated HTML is sanitized and rendered with JavaScript turned off (`javaScriptEnabled: false`).
4. **Resilient Failure Checkpoints:** If a worker dies after `docs.save`, the next attempt uses the saved attachment directly without re-fetching or re-uploading.
