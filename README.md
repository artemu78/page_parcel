# Readable Web (VK Web-to-Readable-PDF Bot)

Production-minded MVP of a VK community bot that converts public web articles and documentation pages into clean, readable, offline PDFs and replies with native VK document attachments.

---

## 1. Product Purpose & Scope

* **User Interaction:**
  * `/read <URL>`: Fetches the public article, extracts readable text and layout, creates a reader-style PDF, uploads it to VK Documents, and replies with a native document attachment in private VK messages.
  * `/status <job-id>`: Reports the current processing status, attempts, and safe error details (strictly accessible only to the job owner).
  * `/help`: Displays service usage, capabilities, and limitations.
* **Scope Boundaries:**
  * **Read-only web-to-PDF:** Target public articles and documentation.
  * **No bypasses:** Does not bypass paywalls, CAPTCHAs, or authentication. Never uses cookies, credentials, or sessions.
  * **MVP Defers:** Group chats, images in PDFs, original page snapshot mode, multi-page crawling, audio/video/office file conversions.

---

## 2. Architecture & Isolation Design

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
                                                                     │ Ephemeral buffer
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

### Chromium Sandboxing & Network Isolation Feasibility Analysis
* **Serverless Container Constraint:** Yandex Serverless Containers enforce a hardened container sandbox that disallows `CLONE_NEWUSER` / user namespaces, which would force Chromium to run with `--no-sandbox`. Running `--no-sandbox` on untrusted public web pages creates severe remote code execution risks. Furthermore, serverless containers do not support host packet filtering (iptables).
* **Hardened Deployment Architecture:**
  * **Webhook:** Runs on **Yandex Serverless Containers** (lightweight Node.js, Callback API validation, rate limiting, and YMQ publishing).
  * **Worker & Renderer:** Runs in a hardened compute environment (**Yandex Managed Service for Kubernetes** or dedicated **Compute Cloud VM**) where unprivileged user namespaces are enabled (`kernel.unprivileged_userns_clone = 1`), allowing Chromium to run with its full sandbox enabled as unprivileged user `pwuser` (UID 10001).
  * **Network Enforcement:** Outbound traffic from the browser context is forced through the internal validating egress proxy (`packages/safe-network`), which enforces destination IP classification at connection time.

---

## 3. Repository Structure

```text
apps/
  webhook/            # VK Callback API ingress, command handling, fast ACK, outbox enqueuing
  worker/             # YMQ trigger consumer, atomic lease claims, rendering & upload orchestration
packages/
  jobs/               # State machine, MemoryJobStore / YdbJobStore, SQS queue client, outbox recovery
  safe-network/       # URL validation, IPv4/IPv6 classification, DNS resolver, validating forward egress proxy
  rendering/          # Sandboxed Playwright Chromium manager, route blocking, Mozilla Readability + fallback
  pdf/                # HTML sanitizer (sanitize-html), reader template, offline PDF generator
  vk/                 # Official VK API client (docs upload & messages.send), token redaction, stable random_id
  observability/      # JSON logger with credential scrubbing, Prometheus metrics registry
infra/
  yandex/             # Terraform IaaS: Serverless Containers, YMQ, DLQ, Trigger, YDB, Lockbox, IAM
  containers/         # Multi-stage Dockerfiles with non-root users (pwuser) and Cyrillic/Latin fonts
tests/
  unit/               # URL validation, IP blocking, command parsing, state machine, leases, sanitizer
  integration/        # Mocked VK and SQS lifecycle, outbox publication, retry checkpoints, cross-user status
  security/           # Real Chromium tests: SSRF blocking, DNS rebinding, oversized streams, offline PDF
docs/
  architecture.md     # In-depth architectural design and platform feasibility analysis
  threat-model.md     # Concise threat model (trust boundaries, SSRF, DoS, credentials, privacy)
  operations.md       # Operational runbook (retries, DLQ redrive, secret rotation, limits, cleanup)
```

---

## 4. Getting Started & Verification

### Prerequisites
* Node.js >= 22.0.0 (LTS)
* npm >= 10.9.0

### Installation & Build
```bash
# Install dependencies
npm install

# Build all packages and applications
npm run build

# Typecheck all TypeScript code
npm run typecheck
```

### Running Tests
```bash
# Run all test suites (unit, integration, and security with real Chromium)
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Run security tests only
npm run test:security
```

---

## 5. Local Development Mode

To run locally with simulated VK and queue:
```bash
cp .env.example .env
# Edit .env with your local ports or development credentials

# Start webhook server (default port 8080)
node apps/webhook/dist/index.js

# In another terminal, start worker server (default port 8081)
node apps/worker/dist/index.js
```

---

## 6. Verification Status Report

| Capability / Requirement | Verification Status | Evidence / Notes |
| :--- | :--- | :--- |
| **Command parsing (`/read`, `/status`, `/help`)** | **Verified (Unit)** | 100% covered in `tests/unit/commands-and-callback.test.ts` |
| **VK Callback API validation & confirmation** | **Verified (Unit)** | Secret, group ID, confirmation token, and 'ok' responses tested |
| **URL syntax & credential rejection** | **Verified (Unit)** | Prohibited schemes, ports, and embedded credentials tested |
| **IP classification (IPv4, IPv6, mapped, metadata)** | **Verified (Unit)** | Link-local (`169.254.169.254`), loopback, private ranges tested |
| **Atomic leases, fencing, and deduplication** | **Verified (Unit & Int)** | MemoryJobStore atomic claims, lease expiry, optimistic locks tested |
| **Per-user atomic rate limiting** | **Verified (Unit)** | Sliding window limits tested |
| **HTML Sanitization & Cyrillic reader PDF** | **Verified (Unit & Sec)** | Dangerous tags stripped, Cyrillic fonts preserved in PDF output |
| **Checkpointing & delivery retry** | **Verified (Int)** | Reuses existing VK document attachment on retry without re-upload |
| **Cross-user status protection** | **Verified (Int)** | Only job owner can inspect status; access denied to other users |
| **SSRF socket-level blocking (127.0.0.1, 169.254.169.254)** | **Verified (Security)** | Real Chromium + real test server: proved internal server was never reached |
| **DNS rebinding protection** | **Verified (Security)** | Connection-time DNS re-evaluation blocks rebinding to private IPs |
| **Streaming response limit (> 5 MiB cutoff)** | **Verified (Security)** | Egress proxy stream meter aborts connections exceeding limit |
| **Offline PDF generator network isolation** | **Verified (Security)** | Proved PDF print context cannot make external network calls |
| **End-to-End Smoke Test** | **Verified (Local Mock)** | Full pipeline from command to queue to PDF generation to delivery |
| **Live Yandex Cloud Deployment** | **Unverified (Requires Cloud)** | Reproducible Terraform and Dockerfiles provided in `infra/` |
| **Live VK Messenger Delivery** | **Unverified (Requires Token)** | Complete official API client implemented; awaiting real VK group token |

---

## 7. Console & CLI Operations Guide (No Yandex Software Required)

Manage your cloud resources and containers using only standard **Terraform CLI** and **Docker**.

### A. Infrastructure Management (via Terraform)

All Terraform commands are run from the [`infra/yandex/`](file:///Users/artemreva/projects/proxy_pdf/infra/yandex/) directory.

### A. Initial Setup: Create Container Registry First

Because Serverless Containers require the Docker images to already exist in the registry when created, we provision the **Container Registry** first:

1. **Create only the Container Registry:**
   ```bash
   cd infra/yandex
   terraform apply -target=yandex_container_registry.registry
   ```
   *(Type `yes` when prompted).*

2. **Retrieve the created Registry ID:**
   ```bash
   terraform output -raw registry_id
   ```

---

### B. Building & Pushing Docker Images (via Docker)

From the **project root directory** (`/Users/artemreva/projects/proxy_pdf`):

1. **Log in Docker to Yandex Container Registry** (using `authorized_key.json`):
   ```bash
   cat infra/yandex/authorized_key.json | docker login --username json_key --password-stdin cr.yandex
   ```

2. **Get your Registry ID into a shell variable:**
   ```bash
   REGISTRY_ID=$(terraform -chdir=infra/yandex output -raw registry_id)
   ```

3. **Build the container images:**
   ```bash
   docker build -t cr.yandex/$REGISTRY_ID/webhook:latest -f infra/containers/Dockerfile.webhook .
   docker build -t cr.yandex/$REGISTRY_ID/worker:latest -f infra/containers/Dockerfile.worker .
   ```

4. **Push the images:**
   ```bash
   docker push cr.yandex/$REGISTRY_ID/webhook:latest
   docker push cr.yandex/$REGISTRY_ID/worker:latest
   ```

---

### C. Deploy Full Infrastructure

Now that the images are in the registry, deploy the remaining containers, queues, database, and trigger:

```bash
cd infra/yandex
terraform apply
```

To view your deployed Webhook URL:
```bash
terraform output -raw webhook_url
```

To destroy all cloud resources when done:
```bash
cd infra/yandex
terraform destroy
```

---

### C. Managing Secrets in Yandex Lockbox (via Web Console)

Once Terraform creates the secret `readable-web-vk-secrets`:
1. Open [console.yandex.cloud](https://console.yandex.cloud) in your browser.
2. Go to **Lockbox** in the left menu.
3. Click on **`readable-web-vk-secrets`** and click **Create version** (Создать версию):
   - Key: `vk_secret` → Value: *(your Callback API secret)*
   - Key: `vk_confirmation_code` → Value: *(your Callback API confirmation string)*
   - Key: `vk_group_token` → Value: *(your VK Community Access Token)*
4. Click **Save**. The Serverless Containers will automatically load these secrets into environment variables at runtime.

---

### D. Monitoring & Troubleshooting (via Web Console)

* **View Logs in Real Time:** Open [console.yandex.cloud](https://console.yandex.cloud) ➔ **Serverless Containers** ➔ Select `readable-web-webhook` or `readable-web-worker` ➔ Click **Logs** (Логи).
* **Inspect Queues & Dead Letters:** Go to **Cloud Message Queue** ➔ Check message count in `readable-web-jobs` and `readable-web-dlq`.
* **Inspect Job Metadata & States:** Go to **Managed Service for YDB** ➔ `readable-web-ydb` ➔ **Navigation** ➔ View entries in the `jobs` table.

