import { describe, expect, it } from "vitest";
import { runResourceStream, type StreamEvent } from "../src/client/streamClient.js";
import { startTestServer, type TestServer } from "./helpers/testServer.js";

const PROGRESS_URI = "test://review/progress";
const STATUS_URI = "test://review/status";

async function withServer(
  options: Parameters<typeof startTestServer>,
  run: (server: TestServer, events: StreamEvent[]) => Promise<void>,
): Promise<void> {
  const server = await startTestServer(...options);
  try {
    await run(server, []);
  } finally {
    await server.close();
  }
}

describe("runResourceStream", () => {
  it("4段階の更新を逐次配送し、terminal の snapshot で一致して終了する", async () => {
    await withServer([0.1], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 10_000,
        until: { pointer: "/terminal", expected: true },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: true, errorCode: null, listenAcknowledged: true });
      expect(events[0]).toEqual({ type: "ack", resourceUri: PROGRESS_URI, honoredUris: [PROGRESS_URI] });
      const snapshots = events.filter((event) => event.type === "snapshot");
      expect(snapshots[0]).toMatchObject({ source: "post-listen", matched: false });
      expect(snapshots.at(-1)).toMatchObject({ source: "notification", matched: true });
      expect(snapshots.filter((event) => event.matched)).toHaveLength(1);
    });
  }, 20_000);

  it("listen 前に確定済みの値は ack 後の read で検出して通知を待たない", async () => {
    await withServer([5], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 5000,
        until: { pointer: "/revision", expected: 1 },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: true, notificationCount: 0 });
      expect(events.map((event) => event.type)).toEqual(["ack", "snapshot"]);
    });
  }, 15_000);

  it("非 JSON 本文は空 Pointer の =null に一致せず、待機を続けて timeout する", async () => {
    await withServer([0.05], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: STATUS_URI,
        timeoutMs: 800,
        until: { pointer: "", expected: null },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: false, errorCode: "NOTIFICATION_TIMEOUT" });
      const snapshots = events.filter((event) => event.type === "snapshot");
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({ json: null, matched: false });
      }
    });
  }, 15_000);

  it("read が timeout 予算を超える場合は、一致する値でも成功にせず予算内で構造化エラーにする", async () => {
    await withServer([5, 700], async (server, events) => {
      const startedAt = performance.now();
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 300,
        until: { pointer: "/revision", expected: 1 },
        onEvent: (event) => events.push(event),
      });
      const elapsedMs = performance.now() - startedAt;

      expect(result).toMatchObject({ matched: false, errorCode: "NOTIFICATION_TIMEOUT", listenAcknowledged: true });
      // read の応答（700ms 後）を待たずに打ち切る。ack までは配送済みで、snapshot は出ない。
      expect(elapsedMs).toBeLessThan(650);
      expect(events.map((event) => event.type)).toEqual(["ack"]);
    });
  }, 15_000);

  it("認証などで予算を使い切っている場合は通信せず timeout にする", async () => {
    await withServer([0.05], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 0,
        until: { pointer: "/terminal", expected: true },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: false, errorCode: "NOTIFICATION_TIMEOUT", listenAcknowledged: false });
      expect(events).toEqual([]);
    });
  });

  it("一致しないまま timeout した場合は NOTIFICATION_TIMEOUT で終了する", async () => {
    await withServer([0.1], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 1500,
        until: { pointer: "/stage", expected: "never" },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: false, errorCode: "NOTIFICATION_TIMEOUT", listenAcknowledged: true });
    });
  }, 15_000);

  it("一覧に無い URI は ack なしで RESOURCE_NOT_FOUND を返す", async () => {
    await withServer([0.05], async (server, events) => {
      const result = await runResourceStream({
        url: server.url,
        uri: "test://review/unknown",
        timeoutMs: 3000,
        until: { pointer: "/terminal", expected: true },
        onEvent: (event) => events.push(event),
      });

      expect(result).toMatchObject({ matched: false, errorCode: "RESOURCE_NOT_FOUND", listenAcknowledged: false });
      expect(events).toEqual([]);
    });
  });

  it("listen stream の異常切断は SUBSCRIPTION_DISCONNECTED で停止し、成功扱いにしない", async () => {
    await withServer([60], async (server, events) => {
      let dropped = false;
      const result = await runResourceStream({
        url: server.url,
        uri: PROGRESS_URI,
        timeoutMs: 10_000,
        until: { pointer: "/terminal", expected: true },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "snapshot" && !dropped) {
            dropped = true;
            server.dropConnections();
          }
        },
      });

      expect(dropped).toBe(true);
      expect(result).toMatchObject({ matched: false, errorCode: "SUBSCRIPTION_DISCONNECTED", closeReason: "remote" });
    });
  }, 20_000);
});
