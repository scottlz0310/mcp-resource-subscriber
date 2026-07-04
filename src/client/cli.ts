#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthLoginRequiredError, loginToGateway, resolveCachedToken } from "./auth/gatewayAuth.js";
import { OAuthRequestError } from "./auth/oauthClient.js";
import { openTokenStore, tokenStoreExists } from "./auth/tokenStore.js";
import { buildErrorJsonOutput, buildJsonOutput } from "./jsonOutput.js";
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

// Throw-safe variant for best-effort context capture outside the try block.
function peekOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const index = process.argv.findIndex((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (index === -1) return undefined;
  const arg = process.argv[index];
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`${pkg.name} v${pkg.version}`);
  console.log("");
  console.log("Usage:");
  console.log(
    "  mcp-resource-subscriber --url <server-url> [--uri <resource-uri>] [--auth-token <tok>] [--skip-resource-list-check] [--timeout-ms <ms>] [--json]",
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
  console.log("  --login             Interactive device-flow login (RFC 8628) against the");
  console.log("                      gateway serving --url. Prints a verification URI to");
  console.log("                      approve in a browser, then caches the issued tokens so");
  console.log("                      later runs authenticate and refresh automatically.");
  console.log("                      Explicit --auth-token / MCP_PROBE_AUTH_TOKEN always");
  console.log("                      override the cache. Cache: MCP_PROBE_TOKEN_STORE_PATH");
  console.log("  --skip-resource-list-check");
  console.log("                      Skip resources/list and assume the URI exists.");
  console.log("                      Use for servers with dynamic resources not in list.");
  console.log("                      Env: MCP_PROBE_SKIP_LIST_CHECK=true");
  console.log("  --timeout-ms <ms>   Notification wait timeout in ms (default: 15000)");
  console.log("                      Env: MCP_PROBE_TIMEOUT_MS");
  console.log("  --json              Emit a single JSON object to stdout instead of line-based output.");
  console.log("                      Diagnostic messages are written to stderr only.");
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
  console.log("");
  console.log("  # JSON output mode (for agent workflow integration):");
  console.log("  mcp-resource-subscriber --url http://localhost:3000/mcp \\");
  console.log("    --uri queue://review/re-review-requests \\");
  console.log("    --timeout-ms 900000 \\");
  console.log("    --json");
  console.log("");
  console.log("  # One-time interactive login against an mcp-gateway:");
  console.log("  mcp-resource-subscriber --login --url http://127.0.0.1:8080/mcp/subscribe-probe");
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

if (args.includes("--login")) {
  const loginUrl = peekOption("url") ?? process.env.MCP_PROBE_URL ?? null;
  let loginExitCode = 0;
  if (loginUrl === null) {
    console.error("--login requires --url (or MCP_PROBE_URL) pointing at the gateway MCP endpoint");
    console.log("login-status failed");
    console.log("error-code SERVER_URL_UNKNOWN");
    loginExitCode = 1;
  } else {
    const store = openTokenStore();
    try {
      const result = await loginToGateway(loginUrl, store, (deviceAuth) => {
        console.log(`user-code ${deviceAuth.userCode}`);
        console.log(`verification-uri ${deviceAuth.verificationUri}`);
        if (deviceAuth.verificationUriComplete) {
          console.log(`verification-uri-complete ${deviceAuth.verificationUriComplete}`);
        }
        console.error("Open the verification URI in a browser and approve this device. Waiting for approval...");
      });
      console.log("login-status success");
      console.log(`token-origin ${result.origin}`);
      console.log(`token-expires-at ${new Date(result.expiresAt).toISOString()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`login failed: ${message}`);
      console.log("login-status failed");
      loginExitCode = 1;
    } finally {
      store.close();
    }
  }
  process.exit(loginExitCode);
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
  const skipResourceListCheck =
    args.includes("--skip-resource-list-check") || process.env.MCP_PROBE_SKIP_LIST_CHECK === "true";
  const json = args.includes("--json");
  return { url, uri, timeoutMs, authToken, skipResourceListCheck, authTokenFromFlag, json };
}

/**
 * Explicit tokens (--auth-token / MCP_PROBE_AUTH_TOKEN) always win so existing
 * callers keep full control; the login cache is only consulted when no token
 * was provided. May throw AuthLoginRequiredError / OAuthRequestError when the
 * cached token is expired and unattended refresh fails.
 */
async function resolveBearerToken(url: string, explicitToken: string | null): Promise<string | null> {
  if (explicitToken !== null) {
    return explicitToken;
  }
  // Never create the token store as a probe side effect: runs that have not
  // used --login keep their exact pre-auth behavior (and stay contention-free
  // when many probes run in parallel).
  if (!tokenStoreExists()) {
    return null;
  }
  const store = openTokenStore();
  try {
    const resolved = await resolveCachedToken(url, store);
    if (resolved.source !== "none") {
      console.error(`auth token source: ${resolved.source}`);
    }
    return resolved.token;
  } finally {
    store.close();
  }
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

// Capture context outside try so the catch block can report actuals instead of unknowns.
// Use peekOption (no-throw) so malformed args don't produce a bare stack trace before the try.
const jsonMode = args.includes("--json");
let capturedUrl: string | null = peekOption("url") ?? process.env.MCP_PROBE_URL ?? null;
let capturedUri: string = peekOption("uri") ?? process.env.MCP_PROBE_URI ?? REVIEW_STATUS_URI;

try {
  const options = parseOptions();
  capturedUrl = options.url;
  capturedUri = options.uri;

  if (options.url === null) {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildErrorJsonOutput("SERVER_URL_UNKNOWN", null, options.uri))}\n`);
    } else {
      console.log("error-code SERVER_URL_UNKNOWN");
      console.log("phase-summary route=failed url=unknown error-code=SERVER_URL_UNKNOWN");
    }
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
    const bearerToken = await resolveBearerToken(options.url, options.authToken);
    const result = await runSubscribeProbe({
      url: options.url,
      uri: options.uri,
      timeoutMs: options.timeoutMs,
      requestHeaders: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined,
      skipResourceListCheck: options.skipResourceListCheck,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildJsonOutput(result, options.url, options.uri))}\n`);
    } else {
      printResult(result, options.url, options.uri);
    }
    if (result.errorCode) {
      process.exitCode = 1;
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`subscribe-probe failed: ${message}`);
  let errorCode = "INTERNAL_ERROR";
  if (error instanceof AuthLoginRequiredError) {
    errorCode = "AUTH_LOGIN_REQUIRED";
    console.error(
      `hint: run \`mcp-resource-subscriber --login --url ${capturedUrl ?? "<gateway-url>"}\` to re-authenticate`,
    );
  } else if (error instanceof OAuthRequestError) {
    // Transient gateway-side refresh failure (5xx / temporarily_unavailable);
    // the refresh token was restored server-side, so a plain retry is enough.
    errorCode = "AUTH_REFRESH_FAILED";
  }
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(buildErrorJsonOutput(errorCode, capturedUrl, capturedUri))}\n`);
  } else {
    console.log(`error-code ${errorCode}`);
    console.log(
      `phase-summary route=failed url=${capturedUrl ?? "unknown"} uri=${capturedUri} error-code=${errorCode}`,
    );
  }
  process.exitCode = 1;
}
