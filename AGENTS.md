# Agent guide

## Project purpose

Readable Web is a VK community bot that turns public articles and documentation pages into readable PDFs and delivers them as VK document attachments. Preserve the scope: public content, no authentication or paywall bypass, and a reader-style document rather than a page screenshot. See [README.md](README.md) for user commands, scope, setup, and current implementation gaps.

## Reading map

- [README.md](README.md): start here for project goals and repository orientation.
- [Architecture](docs/architecture.md): component boundaries, job lifecycle, and proposed deployment design. Read before changing orchestration or persistence.
- [Threat model](docs/threat-model.md): trust boundaries and intended security safeguards. Read before changing fetching, rendering, PDF generation, logging, or credential handling.
- [Operations](docs/operations.md): configuration, retries, recovery, secrets, and cleanup. Read before changing runtime behavior or deployment.
- [Package scripts](package.json) and [environment example](.env.example): development entry points and configuration examples.
- [Infrastructure](infra/yandex/main.tf) and [deployment script](scripts/deploy.sh): actual deployment configuration and automation.
- [YDB inspector](scripts/ydb-inspect.ts): CLI utility to connect to Yandex Database (YDB), inspect table schemas, and view stored data.

Some existing design and operations statements may be ahead of or inconsistent with implementation. In particular, Terraform defines a serverless worker, and Chromium launch settings currently disable its sandbox. Do not present proposed safeguards as implemented guarantees. Check code and tests, and report discrepancies explicitly.

## Code map

- `apps/webhook`: callback validation, commands, job acceptance, and outbox publication.
- `apps/worker`: queue-trigger handling and processing orchestration.
- `packages/jobs`: job models, stores, leases, queue clients, and outbox recovery.
- `packages/safe-network`: URL/IP validation, DNS handling, and validating egress proxy.
- `packages/rendering`: browser lifecycle and article extraction.
- `packages/pdf`: sanitization, reader template, and PDF generation.
- `packages/vk`: VK uploads and message delivery.
- `packages/observability`: logging and metrics.
- `infra/`: container images and cloud infrastructure.
- `tests/`: unit, integration, and security checks.

## Working rules

- Inspect the relevant implementation and tests before editing. Keep changes focused and preserve unrelated work.
- Edit TypeScript source. JavaScript, declaration files, and source maps also exist alongside sources; do not treat them as independent implementations or hand-edit them to fix behavior. Inspect build output before including generated changes.
- Preserve distinctions between a job, a processing attempt, and a queue message, and between generating a PDF, uploading a document, and delivering a message. Check the existing state model before changing retry behavior.
- Preserve owner-only status access, deduplication, lease/fencing checks, and attachment checkpoints when changing job processing.
- Treat submitted URLs and retrieved pages as untrusted. Evaluate changes against the threat model and relevant security tests.
- Keep credentials and private payloads out of committed files, logs, and reports. Use placeholders in documentation.
- Bump version in package.json once changes are done.
- Use Context7 for current library, framework, SDK, API, CLI, or cloud-service documentation: resolve the library ID first, then query the relevant concept. This is unnecessary for general programming, business-logic debugging, or code review alone. If unavailable, state that limitation and use official documentation.

## Verification and documentation

- Build with `npm run build` before tests: tests import `dist` output.
- Run `npm run typecheck` for TypeScript changes and the relevant suite: `npm run test:unit`, `npm run test:integration`, or `npm run test:security`. Use `npm test` when the change spans suites.
- Browser-dependent tests need Chromium and its runtime dependencies. Report unavailable checks separately from failures; do not infer a pass from test-file presence.
- Distinguish static inspection, mocked tests, real-browser tests, and live cloud/VK verification. Include the commands and outcomes actually observed.
- For documentation-only changes, check links and claims against their source files; application tests are unnecessary unless behavior also changes.
- Update the relevant document when scope, behavior, configuration, or architecture changes. Keep README concise and link to detail instead of duplicating it. Label proposals and known implementation gaps explicitly.

## Database schema and inspection

The script [`scripts/ydb-inspect.ts`](scripts/ydb-inspect.ts) connects directly to Yandex Database (YDB), reads table schemas, and outputs sample data. Run it via:

```bash
npm run ydb:inspect
# or with specific options:
npx tsx scripts/ydb-inspect.ts --table Users
npx tsx scripts/ydb-inspect.ts --schema-only
npx tsx scripts/ydb-inspect.ts --limit 20 --json
```

### CLI options
- `--table, -t <name>`: Target a specific table (e.g. `Users`, `Settings`, `Roles`, `jobs`, `events`, `rate_limits`).
- `--limit, -l <n>`: Max rows to fetch per table (default: `10`).
- `--schema-only`: Display table columns, types, and primary keys without fetching rows.
- `--data-only`: Output table rows without column definitions.
- `--json`: Format output as machine-readable JSON.

### Configuration resolution
- **Credentials**: Reads `YDB_SERVICE_ACCOUNT_KEY_FILE_CREDENTIALS` or automatically falls back to `infra/yandex/authorized_key.json` if present.
- **Endpoint**: Reads `YDB_ENDPOINT` (defaults to `grpcs://ydb.serverless.yandexcloud.net:2135`).
- **Database**: Reads `YDB_DATABASE`, falling back to `infra/yandex/terraform.tfstate`.

### YDB Tables
1. **`jobs`**: Persistent state machine for PDF extraction and delivery jobs (`id` PK). Contains owner info, lease fencing (`lease_owner`, `lease_expires_at`), retry attempt counters, and VK attachment checkpoint.
2. **`events`**: Idempotency records mapping VK Callback API event IDs to job IDs (`event_id` PK).
3. **`rate_limits`**: Atomic per-user sliding window request tracking (`user_id, timestamp` compound PK).
4. **`Settings`**: Dynamic key-value operational configuration (`key` PK).
5. **`Users`**: User registry tracking lifetime interactions, access control, and blocked status (`ID` PK).
6. **`Roles`**: Role mapping linking users to administrative privileges and error listener notifications (`User, Role` compound PK).

