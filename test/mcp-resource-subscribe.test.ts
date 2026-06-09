import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ErrorCode,
  isInitializeRequest,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  ResourceUpdatedNotificationSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { buildJsonOutput, type JsonOutput } from "../src/client/jsonOutput.js";
import { extractRecommendedAction, runSubscribeProbe } from "../src/client/probeClient.js";
import { configFromEnv, type TestConfig } from "../src/server/config.js";
import { createMcpHttpApp } from "../src/server/httpServer.js";
import {
  createInitialReviewStatus,
  createUpdatedReviewStatus,
  REVIEW_STATUS_RESOURCE,
  REVIEW_STATUS_URI,
  renderReviewStatus,
} from "../src/server/resourceState.js";

const TEST_CONFIG: TestConfig = {
  port: 0,
  mcpPath: "/mcp",
  updateDelaySeconds: 0.05,
  initialStatus: "pending",
  updatedStatus: "reviewed",
  sendListChanged: false,
  logLevel: "silent",
};

const servers: Server[] = [];
const clients: Client[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(logs: string[]) {
  const app = createMcpHttpApp(TEST_CONFIG, (line) => logs.push(line));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

function getText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0];
  if (!first || !("text" in first)) {
    throw new Error("Expected text resource content");
  }

  return first.text;
}

function waitForUpdatedNotification(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for resource update notification"));
    }, 2_000);

    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      clearTimeout(timeout);
      resolve(notification.params.uri);
    });
  });
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

async function startSubscribeRejectingServer(): Promise<string> {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") ?? undefined;
    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown session" }, id: null });
          return;
        }
      } else if (isInitializeRequest(req.body)) {
        const mcpServer = new McpServer(
          { name: "test-no-subscribe", version: "0.1.0" },
          { capabilities: { resources: { subscribe: true } } },
        );

        mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: [REVIEW_STATUS_RESOURCE],
        }));

        mcpServer.server.setRequestHandler(ReadResourceRequestSchema, async () => ({
          contents: [
            {
              uri: REVIEW_STATUS_URI,
              mimeType: "text/plain",
              text: renderReviewStatus(createInitialReviewStatus(TEST_CONFIG)),
            },
          ],
        }));

        mcpServer.server.setRequestHandler(SubscribeRequestSchema, async () => {
          throw new McpError(ErrorCode.MethodNotFound, "Subscriptions not supported by this server");
        });

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) transports.set(id, transport);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        await mcpServer.connect(transport);
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

interface ActionSequenceReadContext {
  readCount: number;
  textIndex: number;
  setTextIndex: (index: number) => void;
  sendUpdate: () => Promise<void>;
}

interface ActionSequenceServerOptions {
  readText?: (context: ActionSequenceReadContext) => string | Promise<string>;
}

async function startActionSequenceServer(
  texts: string[],
  updateDelaysMs: number[],
  options: ActionSequenceServerOptions = {},
): Promise<string> {
  const app = express();
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

  app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") ?? undefined;
    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        transport = transports.get(sessionId);
        if (!transport) {
          res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown session" }, id: null });
          return;
        }
      } else if (isInitializeRequest(req.body)) {
        const mcpServer = new McpServer(
          { name: "test-action-sequence", version: "0.1.0" },
          { capabilities: { resources: { subscribe: true } } },
        );

        let readCount = 0;
        let textIndex = 0;
        const subscriptions = new Set<string>();
        const setTextIndex = (index: number) => {
          textIndex = index;
        };
        const sendUpdate = async () => {
          if (subscriptions.has(REVIEW_STATUS_URI)) {
            await mcpServer.server.sendResourceUpdated({ uri: REVIEW_STATUS_URI });
          }
        };
        mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: [REVIEW_STATUS_RESOURCE],
        }));

        mcpServer.server.setRequestHandler(ReadResourceRequestSchema, async () => {
          readCount++;
          const text = options.readText
            ? await options.readText({ readCount, textIndex, setTextIndex, sendUpdate })
            : (texts[textIndex] ?? "");
          return {
            contents: [{ uri: REVIEW_STATUS_URI, mimeType: "text/plain", text }],
          };
        });

        mcpServer.server.setRequestHandler(SubscribeRequestSchema, async () => {
          subscriptions.add(REVIEW_STATUS_URI);
          updateDelaysMs.forEach((delayMs, index) => {
            setTimeout(() => {
              void (async () => {
                setTextIndex(index + 1);
                await sendUpdate();
              })().catch(() => undefined);
            }, delayMs);
          });
          return {};
        });

        mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async () => {
          subscriptions.delete(REVIEW_STATUS_URI);
          return {};
        });

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) transports.set(id, transport);
          },
          onsessionclosed: (id) => {
            transports.delete(id);
          },
        });
        await mcpServer.connect(transport);
      } else {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") ?? undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!sessionId || !transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id") ?? undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!sessionId || !transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transport.handleRequest(req, res);
    transports.delete(sessionId);
  });

  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe("MCP resource subscription probe", () => {
  it.each([
    ["adds a leading slash", { MCP_TEST_PATH: "custom-mcp" }, "/custom-mcp"],
    ["trims trailing slashes", { MCP_TEST_PATH: "/custom-mcp///" }, "/custom-mcp"],
    ["falls back for blank values", { MCP_TEST_PATH: "   " }, "/mcp"],
  ])("parses MCP_TEST_PATH: %s", (_name, env, expected) => {
    expect(configFromEnv(env).mcpPath).toBe(expected);
  });

  it.each([
    ["key-value text", "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER", "POLL_AFTER"],
    ["inline text", 'final: { review_status: "IN_PROGRESS", recommended_next_action: "POLL_AFTER" }', "POLL_AFTER"],
    ["top-level JSON", JSON.stringify({ recommended_next_action: "READ_REVIEW_THREADS" }), "READ_REVIEW_THREADS"],
    ["nested JSON", JSON.stringify({ watch: { recommended_next_action: "CHECK_FAILURE" } }), "CHECK_FAILURE"],
  ])("extracts recommended_next_action from %s", (_name, text, expected) => {
    expect(extractRecommendedAction(text)).toBe(expected);
  });

  it("exposes get_review_status in tools/list and returns status text on tools/call", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);
    const client = new Client({ name: "test-tool-client", version: "0.1.0" });
    clients.push(client);

    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools).toContainEqual(expect.objectContaining({ name: "get_review_status" }));

    const result = await client.callTool({ name: "get_review_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const texts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    expect(texts).toContain("version: 1");
    expect(texts).toContain("status: pending");

    expect(logs).toContain("[tools/call] get_review_status");
  });

  it("lists, reads, subscribes, notifies, and re-reads the updated resource", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);
    const client = new Client({
      name: "mcp-resource-subscribe-test-client",
      version: "0.1.0",
    });
    clients.push(client);

    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);

    expect(client.getServerCapabilities()?.resources).toEqual({
      subscribe: true,
      listChanged: true,
    });

    const resources = await client.listResources();
    expect(resources.resources).toContainEqual(
      expect.objectContaining({
        uri: REVIEW_STATUS_URI,
        name: "Review Status",
        mimeType: "text/plain",
      }),
    );

    const initial = await client.readResource({ uri: REVIEW_STATUS_URI });
    expect(getText(initial)).toContain("version: 1");
    expect(getText(initial)).toContain("status: pending");

    const notification = waitForUpdatedNotification(client);
    await client.subscribeResource({ uri: REVIEW_STATUS_URI });

    await expect(notification).resolves.toBe(REVIEW_STATUS_URI);

    const updated = await client.readResource({ uri: REVIEW_STATUS_URI });
    expect(getText(updated)).toContain("version: 2");
    expect(getText(updated)).toContain("status: reviewed");

    await client.unsubscribeResource({ uri: REVIEW_STATUS_URI });

    expect(logs).toEqual(
      expect.arrayContaining([
        "[initialize] client connected",
        "[resources/list] requested",
        "[resources/read] uri=test://review/status version=1",
        "[resources/subscribe] uri=test://review/status",
        "[resource/update] uri=test://review/status version=2",
        "[notification/send] notifications/resources/updated uri=test://review/status",
        "[resources/read] uri=test://review/status version=2",
        "[resources/unsubscribe] uri=test://review/status",
      ]),
    );
  });

  it("runs the reusable subscription probe client flow", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      timeoutMs: 2_000,
    });

    expect(result.capabilities).toEqual({
      subscribe: true,
      listChanged: true,
    });
    expect(result.resourceFound).toBe(true);
    expect(result.initialText).toContain("version: 1");
    expect(result.initialText).toContain("status: pending");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(1);
    expect(result.finalText).toContain("version: 2");
    expect(result.finalText).toContain("status: reviewed");
    expect(result.route).toBe("subscription");
    expect(result.subscribed).toBe(true);
    expect(result.unsubscribed).toBe(true);
    expect(result.errorCode).toBeNull();

    expect(logs).toEqual(
      expect.arrayContaining([
        "[resources/subscribe] uri=test://review/status",
        "[notification/send] notifications/resources/updated uri=test://review/status",
        "[resources/read] uri=test://review/status version=2",
        "[resources/unsubscribe] uri=test://review/status",
      ]),
    );
  });

  it("keeps the subscription open while recommended_next_action is POLL_AFTER", async () => {
    const url = await startActionSequenceServer(
      [
        "review_status: PENDING\nrecommended_next_action: POLL_AFTER\nversion: 1",
        "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER\nversion: 2",
        "review_status: COMPLETED\nrecommended_next_action: READ_REVIEW_THREADS\nversion: 3",
      ],
      [20, 40],
    );

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 1_000,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.subscribed).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(2);
    expect(result.finalText).toContain("review_status: COMPLETED");
    expect(result.finalText).toContain("recommended_next_action: READ_REVIEW_THREADS");
    expect(result.unsubscribed).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("does not skip notifications that arrive while reading after a POLL_AFTER notification", async () => {
    const texts = [
      "review_status: PENDING\nrecommended_next_action: POLL_AFTER\nversion: 1",
      "review_status: IN_PROGRESS\nrecommended_next_action: POLL_AFTER\nversion: 2",
      "review_status: COMPLETED\nrecommended_next_action: READ_REVIEW_THREADS\nversion: 3",
    ];
    const url = await startActionSequenceServer(texts, [20], {
      readText: async ({ readCount, textIndex, setTextIndex, sendUpdate }) => {
        if (readCount === 3) {
          setTimeout(() => {
            void (async () => {
              setTextIndex(2);
              await sendUpdate();
            })().catch(() => undefined);
          }, 10);

          await sleep(30);
          return texts[1] ?? "";
        }

        return texts[textIndex] ?? "";
      },
    });

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 1_000,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.subscribed).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.notificationUri).toBe(REVIEW_STATUS_URI);
    expect(result.notificationCount).toBe(2);
    expect(result.finalText).toContain("review_status: COMPLETED");
    expect(result.finalText).toContain("recommended_next_action: READ_REVIEW_THREADS");
    expect(result.unsubscribed).toBe(true);
    expect(result.errorCode).toBeNull();
  });

  it("runs the probe with skipResourceListCheck bypassing the resources/list call", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      timeoutMs: 2_000,
      skipResourceListCheck: true,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.subscribed).toBe(true);
    expect(result.route).toBe("subscription");
    expect(result.errorCode).toBeNull();
    // Verify the resources/list round-trip was skipped
    expect(logs).not.toContain("[resources/list] requested");
  });

  it("returns RESOURCE_NOT_FOUND errorCode when resource URI does not exist", async () => {
    const logs: string[] = [];
    const url = await startServer(logs);

    const result = await runSubscribeProbe({
      url: url.toString(),
      uri: "test://does-not-exist",
      timeoutMs: 2_000,
    });

    expect(result.resourceFound).toBe(false);
    expect(result.errorCode).toBe("RESOURCE_NOT_FOUND");
    expect(result.route).toBe("timeout");
    expect(result.subscribed).toBe(false);
    expect(result.unsubscribed).toBe(false);
  });

  it("returns NOTIFICATION_TIMEOUT errorCode when server never sends notification", async () => {
    const logs: string[] = [];
    // Use a large updateDelaySeconds so the notification never arrives within the probe timeout
    const app = createMcpHttpApp({ ...TEST_CONFIG, updateDelaySeconds: 100 }, (line) => logs.push(line));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${address.port}/mcp`;

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 200,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.errorCode).toBe("NOTIFICATION_TIMEOUT");
    expect(result.route).toBe("timeout");
    expect(result.subscribed).toBe(true);
    expect(result.unsubscribed).toBe(true);
  });

  it("returns SUBSCRIPTION_FAILED errorCode when server rejects the subscribe request", async () => {
    const url = await startSubscribeRejectingServer();

    const result = await runSubscribeProbe({
      url,
      uri: REVIEW_STATUS_URI,
      timeoutMs: 2_000,
    });

    expect(result.resourceFound).toBe(true);
    expect(result.errorCode).toBe("SUBSCRIPTION_FAILED");
    expect(result.route).toBe("timeout");
    expect(result.subscribed).toBe(false);
    expect(result.unsubscribed).toBe(false);
  });

  describe("--json output mode (buildJsonOutput)", () => {
    it("emits valid JSON shape on successful subscription", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({ url: url.toString(), timeoutMs: 2_000 });
      const output = buildJsonOutput(result, url.toString(), REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("subscription");
      expect(json.serverUrl).toBe(url.toString());
      expect(json.resourceUri).toBe(REVIEW_STATUS_URI);
      expect(json.subscribed).toBe(true);
      expect(json.notificationReceived).toBe(true);
      expect(json.notificationCount).toBe(1);
      expect(json.unsubscribed).toBe(true);
      expect(json.errorCode).toBeNull();
      expect(typeof json.initialText).toBe("string");
      expect(typeof json.finalText).toBe("string");
    });

    it("emits valid JSON shape on timeout (failure path)", async () => {
      const url = await startActionSequenceServer(["initial-text"], []);

      const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 100 });
      const output = buildJsonOutput(result, url, REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("timeout");
      expect(json.serverUrl).toBe(url);
      expect(json.resourceUri).toBe(REVIEW_STATUS_URI);
      expect(json.subscribed).toBe(true);
      expect(json.notificationReceived).toBe(false);
      expect(json.notificationCount).toBe(0);
      expect(json.errorCode).toBe("NOTIFICATION_TIMEOUT");
      expect(json.finalText).toBeNull();
    });

    it("emits valid JSON shape when resource is not found", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({
        url: url.toString(),
        uri: "test://does-not-exist",
        timeoutMs: 1_000,
      });
      const output = buildJsonOutput(result, url.toString(), "test://does-not-exist");
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.route).toBe("timeout");
      expect(json.subscribed).toBe(false);
      expect(json.notificationReceived).toBe(false);
      expect(json.errorCode).toBe("RESOURCE_NOT_FOUND");
      expect(json.initialText).toBeNull();
      expect(json.finalText).toBeNull();
    });

    it("sets recommendedNextAction from finalText when present", async () => {
      const url = await startActionSequenceServer(
        ["initial", JSON.stringify({ recommended_next_action: "READ_REVIEW_THREADS" })],
        [20],
      );

      const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 1_000 });
      const output = buildJsonOutput(result, url, REVIEW_STATUS_URI);
      const json = JSON.parse(JSON.stringify(output)) as JsonOutput;

      expect(json.recommendedNextAction).toBe("READ_REVIEW_THREADS");
    });

    it("stdout JSON is valid (serializes without error and round-trips)", async () => {
      const logs: string[] = [];
      const url = await startServer(logs);

      const result = await runSubscribeProbe({ url: url.toString(), timeoutMs: 2_000 });
      const output = buildJsonOutput(result, url.toString(), REVIEW_STATUS_URI);
      const serialized = JSON.stringify(output);

      expect(() => JSON.parse(serialized)).not.toThrow();
      const parsed = JSON.parse(serialized) as JsonOutput;
      expect(Object.keys(parsed)).toEqual([
        "route",
        "serverUrl",
        "resourceUri",
        "subscribed",
        "notificationReceived",
        "notificationCount",
        "unsubscribed",
        "errorCode",
        "initialText",
        "finalText",
        "recommendedNextAction",
      ]);
    });
  });

  it("takes the pre-completion route when resource was already updated before subscription", async () => {
    // Simulates the race condition: the resource updates between initial read and
    // subscribe (i.e., the notification fired before our subscription was established).
    // The server returns version 1 on the first read, accepts subscribe, then returns
    // version 2 on the post-subscribe read without ever sending a notification.
    const app = express();
    const transports = new Map<string, StreamableHTTPServerTransport>();

    app.use(express.json({ limit: "1mb", type: ["application/json", "application/*+json"] }));

    app.post("/mcp", async (req, res) => {
      const sessionId = req.header("mcp-session-id") ?? undefined;
      try {
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId) {
          transport = transports.get(sessionId);
          if (!transport) {
            res.status(404).json({ jsonrpc: "2.0", error: { code: -32000, message: "Unknown session" }, id: null });
            return;
          }
        } else if (isInitializeRequest(req.body)) {
          const mcpServer = new McpServer(
            { name: "test-pre-completed", version: "0.1.0" },
            { capabilities: { resources: { subscribe: true } } },
          );

          let readCount = 0;
          mcpServer.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: [REVIEW_STATUS_RESOURCE],
          }));

          mcpServer.server.setRequestHandler(ReadResourceRequestSchema, async () => {
            readCount++;
            // First read (pre-subscribe): initial state. All subsequent reads: updated state.
            const state =
              readCount === 1 ? createInitialReviewStatus(TEST_CONFIG) : createUpdatedReviewStatus(TEST_CONFIG);
            return { contents: [{ uri: REVIEW_STATUS_URI, mimeType: "text/plain", text: renderReviewStatus(state) }] };
          });

          mcpServer.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
          mcpServer.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              if (transport) transports.set(id, transport);
            },
            onsessionclosed: (id) => {
              transports.delete(id);
            },
          });
          await mcpServer.connect(transport);
        } else {
          res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" }, id: null });
          return;
        }

        await transport.handleRequest(req, res, req.body);
      } catch {
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
      }
    });

    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const { port } = server.address() as import("node:net").AddressInfo;
    const url = `http://127.0.0.1:${port}/mcp`;

    const result = await runSubscribeProbe({ url, uri: REVIEW_STATUS_URI, timeoutMs: 500 });

    expect(result.resourceFound).toBe(true);
    expect(result.subscribed).toBe(true);
    expect(result.unsubscribed).toBe(true);
    expect(result.route).toBe("pre-completion");
    expect(result.initialText).toContain("version: 1");
    expect(result.finalText).toContain("version: 2");
    expect(result.notificationUri).toBe("");
    expect(result.errorCode).toBeNull();
  });
});
