# Local development through a VS Code public port

Research date: 2026-09-30. This is a feasibility report, not an implemented local runner or a verified live VK configuration.

## Conclusion

The proposed callback connection is feasible: VK can call a public HTTPS tunnel that forwards to the local webhook. The missing part in this repository is local job execution, not public connectivity. Running the existing webhook and worker separately with their memory defaults does not connect the job pipeline. A small development runner is the recommended next implementation.

This avoids building and pushing containers for each application change. It still requires internet access for the tunnel, VK, fetched articles, and any configured external APIs.

## VS Code and the public callback address

VS Code includes local-service forwarding without an extension. In a local workspace, open **Ports: Focus on Ports View**, select **Forward a Port**, and enter the webhook port (default `8080`). Sign in when prompted, then right-click the forwarded port and choose **Port Visibility > Public**. Copy its Forwarded Address. Private is the default and requires interactive authentication, so it is unsuitable for a VK callback. This feature targets services on the local machine; ordinary Remote SSH forwarding is a different workflow. [VS Code documentation](https://code.visualstudio.com/docs/debugtest/port-forwarding)

Use the copied HTTPS base address plus `/vk/callback`, for example `https://<copied-tunnel-host>/vk/callback`. Microsoft supplies TLS at tunnel ingress, so the local server may remain HTTP. The service's first-visit anti-phishing page is skipped for methods other than GET; therefore a POST callback should avoid it. This is a documented compatibility inference, not a tested VK request. The relay handles callback bodies and headers, so public forwarding adds Microsoft infrastructure to the data path. [Dev tunnels security](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/security)

Keep the local server, forwarding session, computer, and network available during testing. Do not assume that a VS Code address survives stopping/restarting forwarding: its UI documentation does not guarantee that lifetime. Microsoft separately supports persistent dev tunnels; temporary CLI tunnels are deleted when their hosting connection closes, while explicitly created persistent tunnels can be hosted again. This is an alternative to investigate if repeatedly changing the VK callback address becomes inconvenient, not an assurance about the VS Code UI. [Dev tunnels CLI reference](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands)

The underlying service is intended for development and webhook testing, is in public preview, and has no production SLA. [Dev tunnels overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview) Bandwidth and active-machine limits apply and can change; no numerical quota was verified. [VS Code documentation](https://code.visualstudio.com/docs/debugtest/port-forwarding)

## VK configuration

VK's official SDK describes configuring Callback API under community management. On confirmation, VK sends an event with type `confirmation`; the server returns the community confirmation string. Ordinary events return `ok`. Its example checks both the configured group ID and secret. [Official VK SDK Callback API guide](https://github.com/VKCOM/vk-php-sdk/blob/master/README.md#62-callback-api)

For this application's local environment, provide `VK_GROUP_ID`, `VK_GROUP_TOKEN`, a nonempty `VK_SECRET`, and `VK_CONFIRMATION_CODE` from the development community. Set the same secret in that community's Callback API settings, set the server address to the copied tunnel URL with `/vk/callback`, and request confirmation. Enable the event types used by the application, including `message_new` and `message_allow`. Exact current VK UI labels and API-version selection were not verified. Use a separate development community so local work does not divert production callbacks.

The path is an application choice: `apps/webhook/src/server.ts` accepts POST `/vk/callback` and POST `/`. `apps/webhook/src/handler.ts` validates the callback before returning the confirmation response. `.env.example` documents the relevant variables. The entrypoints read `process.env` and do not themselves load an environment file.

For a partial webhook-only check, after `npm run build`, Node 22 supports loading a local environment file and restarting on changed build output:

```sh
PORT=8080 node --env-file=.env.local --watch apps/webhook/dist/index.js
```

Inherited environment values override file values. This watches the built application, so TypeScript edits still need rebuilding; it does not connect the full job pipeline. Keep the environment file private and use development credentials. [Node 22 CLI documentation](https://nodejs.org/docs/latest-v22.x/api/cli.html)

The main VK developer pages (`https://dev.vk.com/ru/api/callback/getting-started`, `https://dev.vk.com/ru/api/callback/confirmation`, and `https://vk.com/dev/callback_api`) could not be retrieved during this research. The accessible VK-owned SDK supplies protocol evidence, but current callback deadlines, retry policy, URL restrictions, and multiple-server delivery behavior remain unverified. No claim is made that VK currently accepts this particular tunnel domain without a live confirmation test.

## What currently prevents full local execution

Repository inspection found the following behavior:

- The webhook and worker construct separate memory stores. Jobs created in one process are unavailable to the other.
- `MemoryQueueClient.messages` records publications but has no consumer. Starting the webhook with memory defaults can accept `/read` without processing its PDF job.
- The worker's HTTP endpoint accepts a job invocation; it does not poll YMQ. Terraform wires a queue trigger to a deployed worker container ID, not an arbitrary tunnel URL.
- The webhook port also exposes GET `/healthz`, `/readyz`, and `/metrics`. Forwarding its port makes those endpoints public too; selecting a callback path in VK does not restrict the tunnel to that path.

These are implementation findings, not restrictions imposed by VS Code.

## Recommended proposed development mode

Add a single-process local runner that shares a `MemoryJobStore` and `MemorySearchStore`, uses the existing webhook/outbox flow, and consumes published jobs through the existing `JobProcessor`. A serial queued consumer should start processing after publication instead of making callback handling wait for PDF generation. Preserve the existing attempt model, deduplication, leases/fencing, retry decisions, and upload/delivery checkpoints. This remains a proposal; restarting a memory-backed runner would lose its state.

Expose only the webhook port through VS Code. Keep the worker invocation interface and validating egress proxy private. Require a nonempty callback secret in public development mode. The webhook currently publishes metrics on that port; decide whether the development runner should suppress them or provide a callback-only ingress before implementation.

The local renderer needs Chromium and its runtime support. Retain the application's validating network path rather than bypassing it for convenience. Existing Chromium launch flags disable its sandbox, so the current application does not supply a sandboxed-browser guarantee merely because it runs locally. Local smoke testing should use controlled public content and preserve the threat-model boundaries.

For webhook-only work, another option is a local webhook pointed at dedicated development YDB/YMQ resources, with the existing cloud worker consuming that queue. It saves webhook image deployments but leaves worker changes on the container deployment cycle. Sharing production stores/queues is not proposed.

## Verification boundary and next checks

Completed: Context7 library resolution for Visual Studio Code (`/microsoft/vscode-docs`) followed by a documentation query; current official Microsoft documentation retrieval; official VK SDK protocol inspection; repository inspection. The Context7 result covered built-in forwarding but was shallow on visibility/security, so direct official documentation supplied those details.

Not completed: creating a tunnel, changing VK settings, receiving a live callback, local Chromium execution, full PDF upload/delivery, or testing cloud triggers. No credentials or live user payloads were copied into this report.

After the runner exists, verify these distinct stages: a local confirmation POST returns the exact configured string; a public tunnel POST reaches the callback without authentication/interstitial; VK confirms the URL; one development `/read` creates and processes a job; its PDF is uploaded and delivered once; duplicate events and retry scenarios preserve their existing behavior. Docker publishing is unnecessary for that development loop, but cloud/container checks remain necessary before production deployment.
