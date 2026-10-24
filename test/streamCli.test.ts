import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestServer } from "./helpers/testServer.js";

const CLI_SRC = join(process.cwd(), "src", "client", "cli.ts");
const PROGRESS_URI = "test://review/progress";

interface TimedLine {
  at: number;
  value: Record<string, unknown>;
}

interface StreamRun {
  lines: TimedLine[];
  stderr: string;
  exitCode: number | null;
  exitedAt: number;
}

/** JSON でない行は unparsable として保持し、--jsonl のテストでは型の検証で失敗させる。 */
function parseLine(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { type: "unparsable", raw };
  }
}

/** stdout を行単位で受信時刻付きで集める。終了前に行が届くことを検証するため、完了まで待ってから解析しない。 */
function runStream(args: string[], onLine?: (line: TimedLine) => void): Promise<StreamRun> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("node", ["--import", "tsx/esm", CLI_SRC, ...args], {
      env: {
        ...process.env,
        MCP_PROBE_TOKEN_STORE_PATH: join(tmpdir(), "mrs-stream-test-absent", "tokens.db"),
        MCP_PROBE_AUTH_TOKEN: undefined,
        MCP_PROBE_TIMEOUT_MS: undefined,
        MCP_PROBE_URL: undefined,
        MCP_PROBE_URI: undefined,
      },
    });
    const lines: TimedLine[] = [];
    let buffer = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const line = { at: performance.now(), value: parseLine(raw) };
        lines.push(line);
        onLine?.(line);
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolvePromise({ lines, stderr, exitCode, exitedAt: performance.now() });
    });
  });
}

function endLine(run: StreamRun): Record<string, unknown> {
  const last = run.lines.at(-1)?.value;
  expect(last).toMatchObject({ type: "end", schemaVersion: 1 });
  return last as Record<string, unknown>;
}

describe("--jsonl 引数エラー（通信前に失敗する）", () => {
  it.each([
    ["--until 省略", ["--url", "http://127.0.0.1:1/mcp", "--uri", PROGRESS_URI, "--jsonl"], "UNTIL_REQUIRED"],
    [
      "--until の値が JSON でない",
      ["--url", "http://127.0.0.1:1/mcp", "--uri", PROGRESS_URI, "--jsonl", "--until", "/kind=approved"],
      "INVALID_ARGS",
    ],
    [
      "--json と併用",
      ["--url", "http://127.0.0.1:1/mcp", "--uri", PROGRESS_URI, "--jsonl", "--json", "--until", "/terminal=true"],
      "INVALID_ARGS",
    ],
    [
      "URI 未指定",
      ["--url", "http://127.0.0.1:1/mcp", "--jsonl", "--until", "/terminal=true"],
      "RESOURCE_URI_REQUIRED",
    ],
    ["URL 未指定", ["--uri", PROGRESS_URI, "--jsonl", "--until", "/terminal=true"], "SERVER_URL_UNKNOWN"],
  ])(
    "%s",
    async (_name, args, errorCode) => {
      const run = await runStream(args);
      expect(run.exitCode).toBe(1);
      expect(run.lines).toHaveLength(1);
      expect(endLine(run)).toMatchObject({ reason: "error", errorCode, notificationCount: 0 });
    },
    15_000,
  );

  it("--until だけ渡して単発購読に落ちない（黙って無視しない）", async () => {
    const run = await runStream([
      "--url",
      "http://127.0.0.1:1/mcp",
      "--uri",
      PROGRESS_URI,
      "--until",
      "/terminal=true",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("--until は --jsonl と併用してください");
  }, 15_000);
});

describe("--jsonl 逐次出力", () => {
  it("4段階の更新を終了前に逐次出力し、terminal まで終了しない", async () => {
    const server = await startTestServer(0.3);
    try {
      const run = await runStream([
        "--url",
        server.url,
        "--uri",
        PROGRESS_URI,
        "--jsonl",
        "--until",
        "/terminal=true",
        "--timeout-ms",
        "10000",
      ]);

      expect(run.exitCode).toBe(0);
      expect(run.lines[0]?.value).toMatchObject({
        type: "ack",
        schemaVersion: 1,
        resourceUri: PROGRESS_URI,
        honoredUris: [PROGRESS_URI],
      });

      const snapshots = run.lines.filter((line) => line.value.type === "snapshot");
      const first = snapshots[0];
      const last = snapshots.at(-1);
      expect(first?.value).toMatchObject({ source: "post-listen", matched: false });
      expect(last?.value).toMatchObject({ source: "notification", matched: true, notificationUri: PROGRESS_URI });
      expect(last?.value).toMatchObject({ json: { stage: "reviewed" } });

      // 最初の途中更新は、プロセスが終了する前（terminal の更新より前）に届いている。
      expect(first && first.at < run.exitedAt - 300).toBe(true);
      // revision は退行しない。
      const revisions = snapshots.map((line) => (line.value.json as { revision: number }).revision);
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
      expect(snapshots.filter((line) => line.value.matched === true)).toHaveLength(1);

      expect(endLine(run)).toMatchObject({ reason: "until-matched", errorCode: null });
    } finally {
      await server.close();
    }
  }, 20_000);

  it("途中の行は子プロセスの終了を待たずに受け取れる（最初の更新で待機が終わらない）", async () => {
    const server = await startTestServer(0.3);
    try {
      let firstNonTerminalAt: number | null = null;
      const run = await runStream(
        ["--url", server.url, "--uri", PROGRESS_URI, "--jsonl", "--until", "/terminal=true", "--timeout-ms", "10000"],
        (line) => {
          if (line.value.type === "snapshot" && line.value.matched === false) {
            firstNonTerminalAt ??= line.at;
          }
        },
      );
      expect(firstNonTerminalAt).not.toBeNull();
      expect(run.exitedAt - (firstNonTerminalAt ?? run.exitedAt)).toBeGreaterThan(300);
    } finally {
      await server.close();
    }
  }, 20_000);

  it("listen 前に確定済みの結果は ack 後の read で検出して即終了する", async () => {
    const server = await startTestServer(0.3);
    try {
      const run = await runStream([
        "--url",
        server.url,
        "--uri",
        PROGRESS_URI,
        "--jsonl",
        "--until",
        "/revision=1",
        "--timeout-ms",
        "10000",
      ]);
      expect(run.exitCode).toBe(0);
      expect(run.lines.map((line) => line.value.type)).toEqual(["ack", "snapshot", "end"]);
      expect(run.lines[1]?.value).toMatchObject({ source: "post-listen", matched: true });
      expect(endLine(run)).toMatchObject({ reason: "until-matched", notificationCount: 0 });
    } finally {
      await server.close();
    }
  }, 20_000);

  it("終了条件が一致しないまま timeout した場合は失敗として終了する", async () => {
    const server = await startTestServer(0.1);
    try {
      const run = await runStream([
        "--url",
        server.url,
        "--uri",
        PROGRESS_URI,
        "--jsonl",
        "--until",
        '/stage="never"',
        "--timeout-ms",
        "1500",
      ]);
      expect(run.exitCode).toBe(1);
      expect(endLine(run)).toMatchObject({ reason: "error", errorCode: "NOTIFICATION_TIMEOUT" });
      const lastSnapshot = run.lines.filter((line) => line.value.type === "snapshot").at(-1);
      expect(lastSnapshot?.value).toMatchObject({ matched: false, json: { terminal: true } });
    } finally {
      await server.close();
    }
  }, 20_000);

  it("JSON でない本文は json=null の不一致として扱い、待機を続ける", async () => {
    const server = await startTestServer(0.05);
    try {
      const run = await runStream([
        "--url",
        server.url,
        "--uri",
        "test://review/status",
        "--jsonl",
        "--until",
        '/status="reviewed"',
        "--timeout-ms",
        "1000",
      ]);
      expect(run.exitCode).toBe(1);
      const snapshots = run.lines.filter((line) => line.value.type === "snapshot");
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        expect(snapshot.value).toMatchObject({ json: null, matched: false });
      }
      expect(endLine(run)).toMatchObject({ errorCode: "NOTIFICATION_TIMEOUT" });
    } finally {
      await server.close();
    }
  }, 20_000);

  it("存在しない URI は ack なしで RESOURCE_NOT_FOUND を返す", async () => {
    const server = await startTestServer();
    try {
      const run = await runStream([
        "--url",
        server.url,
        "--uri",
        "test://review/unknown",
        "--jsonl",
        "--until",
        "/terminal=true",
        "--timeout-ms",
        "3000",
      ]);
      expect(run.exitCode).toBe(1);
      expect(run.lines).toHaveLength(1);
      expect(endLine(run)).toMatchObject({ reason: "error", errorCode: "RESOURCE_NOT_FOUND" });
    } finally {
      await server.close();
    }
  }, 15_000);

  it("到達できないサーバーは構造化エラー行で失敗する", async () => {
    const run = await runStream([
      "--url",
      "http://127.0.0.1:9/mcp",
      "--uri",
      PROGRESS_URI,
      "--jsonl",
      "--until",
      "/terminal=true",
      "--timeout-ms",
      "3000",
    ]);
    expect(run.exitCode).toBe(1);
    expect(run.lines).toHaveLength(1);
    expect(endLine(run)).toMatchObject({ reason: "error" });
    expect(endLine(run).errorCode).not.toBeNull();
  }, 15_000);

  it("listen stream の異常切断は SUBSCRIPTION_DISCONNECTED で停止し、成功扱いにしない", async () => {
    const server = await startTestServer(60);
    try {
      let dropped = false;
      const run = await runStream(
        ["--url", server.url, "--uri", PROGRESS_URI, "--jsonl", "--until", "/terminal=true", "--timeout-ms", "10000"],
        (line) => {
          if (line.value.type === "snapshot" && !dropped) {
            dropped = true;
            server.dropConnections();
          }
        },
      );
      expect(dropped).toBe(true);
      expect(run.exitCode).toBe(1);
      expect(endLine(run)).toMatchObject({ reason: "error", errorCode: "SUBSCRIPTION_DISCONNECTED" });
    } finally {
      await server.close();
    }
  }, 20_000);
});
