#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractRecommendedAction, runSubscribeProbe } from "./probeClient.js";

// Default URI for the bundled reference server
const REVIEW_STATUS_URI = "test://review/status";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Try compiled path (dist/src/) first, then source path (src/) for tsx direct-run
function readPkg(): { name: string; version: string } {
  for (const rel of ["../../package.json", "../../../package.json", "../package.json"]) {
    try {
      return JSON.parse(readFileSync(resolve(__dirname, rel), "utf8")) as {
        name: string;
        version: string;
      };
    } catch {
      // try next candidate
    }
  }
  return { name: "mcp-resource-subscriber", version: "0.0.0" };
}
const pkg = readPkg();

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (index === -1) {
    return undefined;
  }
  const arg = process.argv[index];
  if (arg.startsWith(prefix)) {
    return arg.slice(prefix.length);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log("");
  console.log("Usage:");
  console.log(
    "  mcp-resource-subscriber --url <server-url> [--uri <resource-uri>] [--auth-token <tok>] [--skip-resource-list-check] [--timeout-ms <ms>]",
  );
  console.log("");
  console.log("Options:");
  console.log("  --url <url>         MCP server Streamable HTTP endpoint");
  console.log("                      Env: MCP_PROBE_URL");
  console.log("  --uri <uri>         Resource URI to subscribe to");
  console.log("                      Default: test://review/status (bundled test server only)");
  console.log("                      Env: MCP_PROBE_URI");
  console.log("  --auth-token <tok>  Bearer token for Authorization header");
  console.log("                      Prefer MCP_PROBE_AUTH_TOKEN env var. Command-line flags");
  console.log("                      are visible in process lists and may be stored in shell");
  console.log("                      history. Env: MCP_PROBE_AUTH_TOKEN (recommended)");
  console.log("  --skip-resource-list-check");
  console.log("                      Skip resources/list and assume the URI exists.");
  console.log("                      Use for servers with dynamic resources not in list.");
  console.log("                      Env: MCP_PROBE_SKIP_LIST_CHECK=true");
  console.log("  --timeout-ms <ms>   Notification wait timeout in ms (default: 15000)");
  console.log("                      Env: MCP_PROBE_TIMEOUT_MS");
  console.log("  --version, -v       Print version and exit");
  console.log("  --help, -h          Print this help and exit");
  console.log("");
  console.log("Examples:");
  console.log("  # Against the bundled test server (must be running on :8089):");
  console.log("  mcp-resource-subscriber --url http://127.0.0.1:8089/mcp");
  console.log("");
  console.log("  # Against copilot-review-mcp:");
  console.log("  mcp-resource-subscriber --url http://127.0.0.1:8080/mcp/copilot-review \\");
  console.log("    --uri copilot-review://watch/<watch_id> \\");
  console.log("    --timeout-ms 900000");
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

function parseOptions() {
  const url = readOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  const uri = readOption("uri") ?? process.env.MCP_PROBE_URI ?? REVIEW_STATUS_URI;
  const timeoutRaw = readOption("timeout-ms") ?? process.env.MCP_PROBE_TIMEOUT_MS ?? "15000";
  const timeoutMs = Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${timeoutRaw}`);
  }
  const authTokenFlag = readOption("auth-token");
  const authToken = authTokenFlag ?? process.env.MCP_PROBE_AUTH_TOKEN ?? null;
  const authTokenFromFlag = authTokenFlag !== undefined;
  const requestHeaders: Record<string, string> | undefined = authToken
    ? { Authorization: `Bearer ${authToken}` }
    : undefined;
  const skipResourceListCheck =
    args.includes("--skip-resource-list-check") || process.env.MCP_PROBE_SKIP_LIST_CHECK === "true";
  return { url, uri, timeoutMs, requestHeaders, skipResourceListCheck, authTokenFromFlag };
}

function printResult(result: Awaited<ReturnType<typeof runSubscribeProbe>>, url: string, uri: string): void {
  console.log(`capabilities ${JSON.stringify(result.capabilities)}`);
  console.log(`resource-found ${result.resourceFound}`);
  console.log(`resource-uri ${uri}`);
  console.log(`server-url ${url}`);
  if (result.initialText) {
    console.log("initial");
    console.log(result.initialText);
  }
  console.log(`route ${result.route}`);
  console.log(`subscribed ${result.subscribed}`);
  console.log(`notification-received ${result.route === "subscription"}`);
  console.log(`notification-count ${result.notificationCount}`);
  console.log(`unsubscribed ${result.unsubscribed}`);
  const recommendedAction = extractRecommendedAction(result.finalText);
  if (recommendedAction) {
    console.log(`recommended_next_action ${recommendedAction}`);
  }
  console.log(`error-code ${result.errorCode ?? "null"}`);
  if (result.notificationUri) {
    console.log(`notification ${result.notificationUri}`);
  }
  if (result.finalText) {
    console.log("final");
    console.log(result.finalText);
  }
  const errorPart = result.errorCode ? ` error-code=${result.errorCode}` : "";
  console.log(`phase-summary route=${result.route} url=${url} uri=${uri}${errorPart}`);
}

try {
  const options = parseOptions();

  if (options.url === null) {
    console.log("error-code SERVER_URL_UNKNOWN");
    console.log("phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN");
    process.exitCode = 1;
  } else {
    if (options.uri === REVIEW_STATUS_URI && !readOption("uri") && !process.env.MCP_PROBE_URI) {
      console.warn(
        "warning: using default URI test://review/status which is only meaningful against the bundled test server",
      );
    }
    if (options.authTokenFromFlag) {
      console.warn(
        "warning: --auth-token value is visible in process lists and may be stored in shell history. Prefer MCP_PROBE_AUTH_TOKEN env var.",
      );
    }
    const result = await runSubscribeProbe({
      url: options.url,
      uri: options.uri,
      timeoutMs: options.timeoutMs,
      requestHeaders: options.requestHeaders,
      skipResourceListCheck: options.skipResourceListCheck,
    });
    printResult(result, options.url, options.uri);
    if (result.errorCode) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`subscribe-probe failed: ${message}`);
  console.log("error-code INTERNAL_ERROR");
  console.log("phase-summary route=failed url=unknown error-code=INTERNAL_ERROR");
  process.exitCode = 1;
}
