import { execFile } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { JsonOutput } from "../src/client/jsonOutput.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";

// Run the TypeScript source directly via tsx so this test suite works on a fresh
// checkout without a prior `pnpm run build` step.
const CLI_SRC = join(process.cwd(), "src", "client", "cli.ts");
const execFileAsync = promisify(execFile);

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("node", ["--import", "tsx/esm", CLI_SRC, ...args], {
      encoding: "utf8",
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", exitCode: err.code ?? 1 };
  }
}

async function startTestServer(updateDelaySeconds = 0.05): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createMcpHttpApp(
    {
      port: 0,
      mcpPath: "/mcp",
      updateDelaySeconds,
      initialStatus: "pending",
      updatedStatus: "reviewed",
      sendListChanged: false,
      logLevel: "silent",
    },
    () => {},
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/mcp`;
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return { url, close };
}

describe("--json CLI process output", () => {
  it("SERVER_URL_UNKNOWN: stdout is valid JSON with errorCode and resourceUri preserved", async () => {
    const result = await runCli(["--uri", "queue://review/queue", "--json"]);

    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout) as JsonOutput;
    expect(json.errorCode).toBe("SERVER_URL_UNKNOWN");
    expect(json.serverUrl).toBeNull();
    expect(json.resourceUri).toBe("queue://review/queue");
    expect(json.subscribed).toBe(false);
  });

  it("SERVER_URL_UNKNOWN: line-based output (no --json) does not emit JSON", async () => {
    const result = await runCli(["--uri", "queue://review/queue"]);

    expect(result.exitCode).toBe(1);
    expect(() => JSON.parse(result.stdout)).toThrow();
    expect(result.stdout).toContain("error-code SERVER_URL_UNKNOWN");
  });

  it("success: stdout is a single valid JSON object, exit code 0", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--json", "--timeout-ms", "3000"]);

      expect(result.exitCode).toBe(0);
      const json = JSON.parse(result.stdout) as JsonOutput;
      expect(json.route).toBe("subscription");
      expect(json.serverUrl).toBe(url);
      expect(json.subscribed).toBe(true);
      expect(json.notificationReceived).toBe(true);
      expect(json.errorCode).toBeNull();
    } finally {
      await close();
    }
  }, 10_000);

  it("NOTIFICATION_TIMEOUT: exit code 1, errorCode in JSON, serverUrl and resourceUri preserved", async () => {
    const { url, close } = await startTestServer(9999);
    try {
      const result = await runCli(["--url", url, "--uri", "test://review/status", "--json", "--timeout-ms", "300"]);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout) as JsonOutput;
      expect(json.errorCode).toBe("NOTIFICATION_TIMEOUT");
      expect(json.serverUrl).toBe(url);
      expect(json.resourceUri).toBe("test://review/status");
    } finally {
      await close();
    }
  }, 10_000);

  it("--auth-token warning goes to stderr only, stdout is pure JSON", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--auth-token", "tok", "--json", "--timeout-ms", "3000"]);

      expect(result.stderr).toContain("--auth-token value is visible");
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const json = JSON.parse(result.stdout) as JsonOutput;
      expect(json.route).toBeDefined();
    } finally {
      await close();
    }
  }, 10_000);

  it("stdout contains exactly one JSON object (no extra lines before/after)", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--json", "--timeout-ms", "3000"]);

      const lines = result.stdout
        .trimEnd()
        .split("\n")
        .filter((l) => l.trim() !== "");
      expect(lines).toHaveLength(1);
      expect(() => JSON.parse(lines[0])).not.toThrow();
    } finally {
      await close();
    }
  }, 10_000);

  it("malformed --uri (missing value): stdout is valid JSON, no stack trace", async () => {
    // --json --uri has no value; peekOption returns undefined (no throw outside try)
    // readOption inside parseOptions throws; catch produces JSON output
    const result = await runCli(["--json", "--uri"]);

    expect(result.exitCode).toBe(1);
    const json = JSON.parse(result.stdout) as JsonOutput;
    expect(json.errorCode).toBe("INTERNAL_ERROR");
    expect(json.subscribed).toBe(false);
    // stdout must not contain a stack trace
    expect(result.stdout).not.toContain("at ");
  });

  it("malformed --timeout-ms with known --url: serverUrl preserved in JSON", async () => {
    const { url, close } = await startTestServer();
    try {
      const result = await runCli(["--url", url, "--timeout-ms", "bad", "--json"]);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout) as JsonOutput;
      expect(json.errorCode).toBe("INTERNAL_ERROR");
      // peekOption captures the url before parseOptions throws at timeoutMs validation
      expect(json.serverUrl).toBe(url);
    } finally {
      await close();
    }
  }, 10_000);
});
