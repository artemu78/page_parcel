# Readable Web (VK Web-to-Readable-PDF Bot)

Production-minded MVP of a VK community bot that converts public web articles and documentation pages into clean, readable, offline PDFs and replies with native VK document attachments.

---

## 1. Product Purpose & Scope

* **User Interaction:**
  * Send a search query as ordinary text: Serper results arrive with inline PDF buttons, seven per message and up to 20 per query. «Ещё» pages through cached results. Searches are limited to one per user every 30 seconds.
  * `/start` or «Начать»: short Russian introduction. The first free-text query and `message_allow` callback also trigger a greeting.
  * `/read <URL>`: Fetches the public article, extracts readable text and layout, creates a reader-style PDF, uploads it to VK Documents, and replies with a native document attachment in private VK messages.
  * `/status <job-id>`: Reports the current processing status, attempts, and safe error details (strictly accessible only to the job owner).
  * `/version`: Reports the running service version, git commit, build timestamp, and runtime environment.
  * `/help`: Displays service usage, capabilities, and limitations.
* **Scope Boundaries:**
  * **Read-only web-to-PDF:** Target public articles and documentation.
  * **No bypasses:** Does not bypass paywalls, CAPTCHAs, or authentication. Never uses cookies, credentials, or sessions.
  * **MVP Defers:** Group chats, images in PDFs, original page snapshot mode, multi-page crawling, audio/video/office file conversions.

---

## 2. Documentation & Architecture

- [Agent guide](AGENTS.md): repository workflow, reading map, and verification rules.
- [Architecture](docs/architecture.md): component responsibilities, job lifecycle, and proposed deployment design.
- [Threat model](docs/threat-model.md): trust boundaries, threats, and intended safeguards.
- [Operations](docs/operations.md): configuration and operational procedures.

The application flow is VK callback → webhook → job store/outbox → queue → worker → article extraction → PDF generation → VK upload and delivery.

### Current implementation and design gaps

- [Terraform](infra/yandex/main.tf) currently defines **both webhook and worker as Yandex Serverless Containers**. The VM/Kubernetes worker described in the architecture document is a proposed design, not the infrastructure implemented here.
- Both [article rendering](packages/rendering/src/browser-manager.ts) and [PDF generation](packages/pdf/src/pdf-generator.ts) currently launch Chromium with `--no-sandbox` and `--disable-setuid-sandbox`. The documentation's sandbox requirement is not implemented by these launch settings.
- The architecture and threat-model documents describe intended safeguards; they are not evidence that every safeguard is implemented or verified. Check the corresponding code and tests before relying on a guarantee.

---

## 3. Repository Structure

```text
apps/
  webhook/            # VK Callback API ingress, command handling, fast ACK, outbox enqueuing
  worker/             # YMQ trigger consumer, atomic lease claims, rendering & upload orchestration
packages/
  jobs/               # State machine, MemoryJobStore / YdbJobStore, SQS queue client, outbox recovery
  safe-network/       # URL validation, IPv4/IPv6 classification, DNS resolver, validating forward egress proxy
  rendering/          # Playwright Chromium manager, route blocking, Mozilla Readability + fallback
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
  architecture.md     # Component design, job lifecycle, and proposed deployment architecture
  threat-model.md     # Concise threat model (trust boundaries, SSRF, DoS, credentials, privacy)
  operations.md       # Operational runbook (retries, DLQ redrive, secret rotation, limits, cleanup)
```

---

## 4. Getting Started & Verification

### Prerequisites
* Node.js >= 22.0.0 (LTS)
* npm with workspace support (the repository does not declare a minimum npm version)

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

Build before starting the applications. Review [.env.example](.env.example) for configuration names and provide actual values through the process environment; the application entrypoints do not load this file automatically.

Start the services in separate terminals, with distinct ports:

```bash
PORT=8080 node apps/webhook/dist/index.js
```

```bash
PORT=8081 node apps/worker/dist/index.js
```

Without YDB configuration, each service creates its own in-memory job store. Without a queue URL, the webhook uses an in-memory queue. These separate processes do **not** form a connected local mock pipeline. Without a VK token, no real VK client is created. Use the test harnesses for mocked lifecycle checks; a connected deployment requires shared persistence and queue delivery to the worker.

Code exceptions are reported as GitHub issues labelled `bug`; third-party HTTP
responses are logged at Info. Configure `GITHUB_REPOSITORY` and the Lockbox
`github_token` entry before production deployment. See the
[reporting runbook](docs/operations.md#6-github-runtime-bug-reporting) for retries,
privacy, and delivery limits.

## 6. Verification

The repository includes [unit tests](tests/unit), [integration tests](tests/integration), and [security tests](tests/security). Tests import built output, so run the build before testing. Browser-based tests require a compatible Chromium installation and runtime dependencies; the [worker Dockerfile](infra/containers/Dockerfile.worker) includes browser setup for its container image. Continuous integration runs the build, typechecks, and the full test suite automatically on pull requests via [GitHub Actions](.github/workflows/test.yml).

Test presence is not a passing result. Record the revision, commands, environment, and outcomes when reporting verification. Mocked checks do not establish live VK delivery or cloud deployment success; those require separate evidence. This README does not claim current live deployment or test status.

---

## 7. Console & CLI Operations Guide (No Yandex Software Required)

Manage your cloud resources and containers using only standard **Terraform CLI** and **Docker**.

### A. Infrastructure Management (via Terraform)

All Terraform commands are run from the [`infra/yandex/`](infra/yandex/) directory.

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

### B. Automated Deployment

Once the initial registry is created, you can build, push, and deploy revisions with a single command from the project root:

```bash
# Deploy both Webhook and Worker containers
npm run deploy

# Or deploy only the Webhook container (fast redeploy for webhook changes)
npm run deploy:webhook

# Or deploy only the Worker container
npm run deploy:worker
```

The script automatically:
1. Attempts registry login with `infra/yandex/authorized_key.json` when present; otherwise relies on existing Docker credentials.
2. Resolves the registry ID from Terraform output.
3. Builds the targeted container(s) for `linux/amd64` with a unique git-based timestamp tag.
4. Pushes the image(s) to Yandex Container Registry.
5. Runs `terraform apply -auto-approve` with the selected image tag overrides. This applies the full configuration, so it can also change other resources; review the Terraform plan and image-tag variables before using the script.
6. Prints the public Webhook URL upon completion.

---

### C. Manual Building & Pushing (via Docker & Terraform CLI)

If you prefer to run each step manually:

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
   docker build --platform linux/amd64 -t cr.yandex/$REGISTRY_ID/webhook:latest -f infra/containers/Dockerfile.webhook .
   docker build --platform linux/amd64 -t cr.yandex/$REGISTRY_ID/worker:latest -f infra/containers/Dockerfile.worker .
   ```

4. **Push the images:**
   ```bash
   docker push cr.yandex/$REGISTRY_ID/webhook:latest
   docker push cr.yandex/$REGISTRY_ID/worker:latest
   ```

5. **Deploy revision via Terraform:**
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

### D. Managing Secrets in Yandex Lockbox (via Web Console)

Once Terraform creates the secret `readable-web-vk-secrets`:
1. Open [console.yandex.cloud](https://console.yandex.cloud) in your browser.
2. Go to **Lockbox** in the left menu.
3. Click on **`readable-web-vk-secrets`** and click **Create version** (Создать версию):
   - Key: `vk_secret` → Value: *(your Callback API secret)*
   - Key: `vk_confirmation_code` → Value: *(your Callback API confirmation string)*
   - Key: `vk_group_token` → Value: *(your VK Community Access Token)*
   - Key: `openrouter_api_key` → Value: *(your OpenRouter API Key for Role 3 text model)*
   - Key: `github_token` → Value: *(fine-grained GitHub token with Issues read/write access to the reporting repository)*
4. Click **Save**. Check the secret-version references in Terraform and deploy revisions that use the intended version; saving a secret version alone is not evidence that running containers use it.

---

### E. Runtime Settings (`Settings` table in YDB)

Dynamic operational key-value settings can be changed in runtime without container redeployment via the `Settings` table in YDB (`readable-web-ydb`):

#### 1. Table Schema
The table is created automatically on worker startup, or can be created manually via YQL in the YDB web console:
```sql
CREATE TABLE Settings (
  key Utf8,
  value Utf8,
  PRIMARY KEY (key)
);
```

* **Supported Keys**:
  * `Model` (or `OpenRouterModel`): Target LLM model identifier on OpenRouter for Role 3 chat (e.g. `google/gemini-2.5-flash`, `openai/gpt-4o-mini`). Default: `google/gemini-2.5-flash`.
  * `Proxy` (or `OpenRouterProxy`): Optional outbound HTTP/HTTPS proxy URL (e.g. `http://user:pass@proxy-host:port`) used by the webhook to bypass geo-restrictions when connecting to OpenRouter.
  * `BaseUrl` (or `OpenRouterBaseUrl`): Optional custom API base URL for OpenRouter (e.g. a reverse proxy URL like `https://my-proxy.workers.dev/api/v1`). Default: `https://openrouter.ai/api/v1`.
  * `MaxRequestsPerJob`: Override default per-job browser navigation and resource request limit.

*(Note: User roles and error notifications previously stored under `AdminID` and `ErrorListeners` have been migrated to the dedicated `Roles` table described below. The service automatically purges these legacy keys from `Settings` on startup).*

---

### F. User & Role Management (`Users` & `Roles` tables in YDB)

User access tracking, access control (blocking), and role assignments are managed in YDB:

#### 1. `Users` Table Schema
Auto-created on service startup or can be created manually in YDB Query editor:
```sql
CREATE TABLE Users (
  ID Int64,
  CreatedAt Timestamp,
  LastAccess Timestamp,
  RequestsCount Int64,
  Status Int32, -- 0 - enabled, 1 - blocked
  ProfileLink Utf8,
  PRIMARY KEY (ID)
);
```

* **Columns**:
  * `ID` *(numeric, PK)*: VKontakte user ID (`from_id`).
  * `CreatedAt` *(timestamp)*: Date and time when the user first interacted with the bot.
  * `LastAccess` *(timestamp)*: Date and time of the user's latest request.
  * `RequestsCount` *(number)*: Total lifetime requests submitted by the user.
  * `Status` *(number)*: `0` = enabled (normal access), `1` = blocked (bot rejects incoming commands with a block notice).
  * `ProfileLink` *(string)*: Direct link to the VK profile (`https://vk.com/id...`).

#### 2. `Roles` Table Schema
```sql
CREATE TABLE Roles (
  User Int64, -- Foreign key referencing Users(ID)
  Role Int32, -- Numeric role identifier
  PRIMARY KEY (User, Role)
);
```

* **Supported Roles**:
  * **Role `1` (`Admin`)**: Service administrator.
  * **Role `2` (`ErrorListeners`)**: Users who receive real-time error notifications in VK direct messages.
  * **Role `3` (`AiChat`)**: Legacy role; ordinary messages now trigger Serper search for all enabled users. OpenRouter client/settings remain available for existing integrations but are no longer routed from free text.

*(Note: Target VK users must have initiated at least one conversation with the VK bot / community so that VK API allows sending direct messages).*

#### 3. Error Notification Delivery
* When an error occurs during job processing, the error details (error text, job ID, requested URL, requester profile link `https://vk.com/id...`) are automatically sent to all users with **Role `2` (`ErrorListeners`)** in the `Roles` table.
* For content extraction errors (`"Could not extract meaningful readable content"`), the alert additionally includes a **`🔍 Диагностика страницы:`** section (probable root cause, `<title>`, HTML byte length, body text length, text snippet, redirect detection, HTTP status, request count) along with the stringified value of the Readability `article` variable for instant diagnostic inspection without redeploying.

#### 4. Common Management Queries
```sql
-- Assign user as ErrorListener (Role 2)
UPSERT INTO Roles (User, Role) VALUES (123456789, 2);

-- Assign user as Admin (Role 1)
UPSERT INTO Roles (User, Role) VALUES (123456789, 1);

-- List all users who receive error logs
SELECT User FROM Roles WHERE Role = 2;

-- Remove ErrorListener role from a user
DELETE FROM Roles WHERE User = 123456789 AND Role = 2;

-- View most active users
SELECT ID, RequestsCount, LastAccess, Status, ProfileLink
FROM Users
ORDER BY RequestsCount DESC;

-- Block a user (status 1)
UPDATE Users SET Status = 1 WHERE ID = 123456789;

-- Unblock a user (status 0)
UPDATE Users SET Status = 0 WHERE ID = 123456789;
```

---

### G. Monitoring & Troubleshooting (via Web Console)

* **View Logs in Real Time:** Open [console.yandex.cloud](https://console.yandex.cloud) ➔ **Serverless Containers** ➔ Select `readable-web-webhook` or `readable-web-worker` ➔ Click **Logs** (Логи).
* **Inspect Queues & Dead Letters:** Go to **Cloud Message Queue** ➔ Check message count in `readable-web-jobs` and `readable-web-dlq`.
* **Inspect Job Metadata & States:** Go to **Managed Service for YDB** ➔ `readable-web-ydb` ➔ **Navigation** ➔ View entries in the `jobs` table.
* **Inspect Users & Roles:** In **Managed Service for YDB** ➔ `readable-web-ydb` ➔ View entries in `Users` and `Roles` tables.
* **Inspect Runtime Settings:** In **Managed Service for YDB** ➔ `readable-web-ydb` ➔ View entries in the `Settings` table.

---

### H. Application Versioning (`/version` command)

* **Source of Truth:** The canonical application version is kept in the root [`package.json`](package.json) (e.g. `"version": "1.0.0"`).
* **Build & Deploy Injection:** During deployment with [`scripts/deploy.sh`](scripts/deploy.sh), the script automatically reads `package.json` and the current git commit (`git rev-parse --short HEAD`), constructing a release identifier (e.g. `v1.0.0 (c4146a8)`), which is passed to Terraform and set as the `APP_VERSION` environment variable in the running containers.
* **Checking Version at Runtime:** Send `/version` (or `/версия`) to the VK community bot in direct messages. The bot will respond with the deployed version and runtime environment details:
  ```text
  📦 Версия сервиса Readable Web: v1.0.0 (c4146a8)
  ⚙️ Среда: production (v22.x.x)
  ```



### Search onboarding and storage

See [search operations](docs/operations.md#7-serper-search) for VK onboarding setup, query-log schema, retention, rate limits, and provider limitations.
