import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { Logger, UpstreamResponseError } from "@readable-web/observability";

const logger = new Logger("info", { component: "VkPreview" });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: npm run vk:preview -- [response.json] [--dry-run]\nLoads .env. Requires VK_GROUP_TOKEN and VK_PREVIEW_PEER_ID to send.",
    );
    return;
  }
  if (args.some((arg) => arg.startsWith("-") && arg !== "--dry-run"))
    throw new Error("Unknown option. Use --help.");
  const files = args.filter((arg) => !arg.startsWith("-"));
  if (files.length > 1) throw new Error("Supply only one response JSON file.");
  try {
    loadEnvFile(".env");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const response: unknown = JSON.parse(
    readFileSync(files[0] ?? "examples/vk-response.json", "utf8"),
  );
  if (!response || typeof response !== "object" || Array.isArray(response))
    throw new Error("Response must be a JSON object.");
  const fields = response as Record<string, unknown>;
  const allowed = new Set([
    "message",
    "attachment",
    "keyboard",
    "template",
    "dont_parse_links",
    "disable_mentions",
  ]);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.has(key))
      throw new Error(
        "Unsupported response field. Allowed: message, attachment, keyboard, template, dont_parse_links, disable_mentions.",
      );
    if (key === "keyboard" || key === "template") {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("keyboard/template must be JSON objects.");
      params.set(key, JSON.stringify(value));
    } else if (key === "dont_parse_links" || key === "disable_mentions") {
      if (typeof value !== "boolean")
        throw new Error("Link/mention options must be booleans.");
      params.set(key, value ? "1" : "0");
    } else {
      if (typeof value !== "string")
        throw new Error("message/attachment must be strings.");
      params.set(key, value);
    }
  }
  if (!params.get("message")?.trim() && !params.get("attachment")?.trim())
    throw new Error("Provide message text or an existing VK attachment.");
  const peerId = Number(process.env.VK_PREVIEW_PEER_ID);
  if (!Number.isSafeInteger(peerId) || peerId <= 0)
    throw new Error(
      "Set VK_PREVIEW_PEER_ID to your numeric VK user ID in .env.",
    );
  params.set("peer_id", String(peerId));
  params.set("random_id", String(randomInt(1, 2147483647)));
  params.set("v", process.env.VK_API_VERSION || "5.199");
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify(Object.fromEntries(params), null, 2));
    console.log("Dry run: no message sent.");
    return;
  }
  const token = process.env.VK_GROUP_TOKEN;
  if (!token || token.includes("EXAMPLE"))
    throw new Error(
      "Set VK_GROUP_TOKEN to your community access token in .env.",
    );
  params.set("access_token", token);
  const result = await fetch("https://api.vk.com/method/messages.send", {
    method: "POST",
    body: params,
    signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) {
    console.log("not ok:", await result.text());
    throw new UpstreamResponseError(
      `VK HTTP status ${result.status}`,
      "VK",
      result.status,
    );
  }

  let data: { error?: { error_code?: number }; response?: unknown };
  try {
    data = (await result.json()) as typeof data;
  } catch {
    console.log("invalid JSON:", await result.text());
    throw new UpstreamResponseError(
      "VK returned invalid JSON",
      "VK",
      result.status,
    );
  }
  if (!data || typeof data !== "object") {
    console.log("invalid response:", await result.text());
    throw new UpstreamResponseError(
      "VK returned an invalid response",
      "VK",
      result.status,
    );
  }
  if (data.error) {
    console.log("API error:", data.error);
    throw new UpstreamResponseError(
      `VK API error ${data.error.error_code ?? "unknown"}. Check messaging permission, recipient access, and response format.`,
      "VK",
      result.status,
    );
  }
  if (!Number.isSafeInteger(data.response) || Number(data.response) <= 0) {
    console.log("invalid message ID:", data.response);
    throw new UpstreamResponseError(
      "VK returned no valid message ID",
      "VK",
      result.status,
    );
  }
  console.log(`Message sent. VK message ID: ${data.response}`);
}

main().catch((error) => {
  logger.exception(error, "Send local VK preview");
  process.exitCode = 1;
});
