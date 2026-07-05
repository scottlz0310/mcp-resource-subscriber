import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ErrorCode,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TestConfig } from "./config.js";
import type { LogSink } from "./logger.js";
import {
  REVIEW_STATUS_MIME_TYPE,
  REVIEW_STATUS_RESOURCE,
  REVIEW_STATUS_URI,
  ReviewStatusStore,
  renderReviewStatus,
} from "./resourceState.js";

export interface ProbeServer {
  server: McpServer;
  store: ReviewStatusStore;
}

function assertReviewStatusUri(uri: string): void {
  if (uri !== REVIEW_STATUS_URI) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource URI: ${uri}`);
  }
}

export function createProbeServer(config: TestConfig, log: LogSink = () => undefined): ProbeServer {
  const server = new McpServer(
    {
      name: "mcp-resource-subscribe-test",
      version: "0.4.0",
    },
    {
      capabilities: {
        resources: {
          subscribe: true,
          listChanged: true,
        },
      },
    },
  );

  const store = new ReviewStatusStore(config);
  const subscriptions = new Set<string>();
  let updateTimer: NodeJS.Timeout | undefined;

  server.registerTool(
    "get_review_status",
    {
      description: `Returns the current review status. Same data as reading the ${REVIEW_STATUS_URI} resource.`,
      inputSchema: z.object({}),
    },
    async () => {
      const state = store.get();
      log("[tools/call] get_review_status");
      return {
        content: [{ type: "text", text: renderReviewStatus(state) }],
      };
    },
  );

  server.registerTool(
    "echo_tool",
    {
      description:
        "Testing utility: echoes back the given message as text content. Pass shouldError: true to simulate a tool-level failure (isError: true), for exercising client-side `call` error handling.",
      inputSchema: z.object({
        message: z.string().optional(),
        shouldError: z.boolean().optional(),
      }),
    },
    async (input) => {
      log(`[tools/call] echo_tool ${JSON.stringify(input)}`);
      return {
        content: [{ type: "text", text: input.message ?? "" }],
        isError: input.shouldError === true,
      };
    },
  );

  const scheduleUpdate = () => {
    if (updateTimer || store.get().version >= 2) {
      return;
    }

    updateTimer = setTimeout(() => {
      void (async () => {
        updateTimer = undefined;
        const state = store.markUpdated();
        log(`[resource/update] uri=${REVIEW_STATUS_URI} version=${state.version}`);

        if (subscriptions.has(REVIEW_STATUS_URI)) {
          log(`[notification/send] notifications/resources/updated uri=${REVIEW_STATUS_URI}`);
          await server.server.sendResourceUpdated({ uri: REVIEW_STATUS_URI });
        }

        if (config.sendListChanged) {
          log("[notification/send] notifications/resources/list_changed");
          await server.server.sendResourceListChanged();
        }
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        log(`[notification/error] ${message}`);
      });
    }, config.updateDelaySeconds * 1000);
  };

  server.server.setRequestHandler(ListResourcesRequestSchema, async () => {
    log("[resources/list] requested");
    return {
      resources: [REVIEW_STATUS_RESOURCE],
    };
  });

  server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    assertReviewStatusUri(uri);

    const state = store.get();
    log(`[resources/read] uri=${uri} version=${state.version}`);

    return {
      contents: [
        {
          uri,
          mimeType: REVIEW_STATUS_MIME_TYPE,
          text: renderReviewStatus(state),
        },
      ],
    };
  });

  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    log(`[resources/subscribe] uri=${uri}`);
    assertReviewStatusUri(uri);

    subscriptions.add(uri);
    scheduleUpdate();

    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    log(`[resources/unsubscribe] uri=${uri}`);
    assertReviewStatusUri(uri);

    subscriptions.delete(uri);
    return {};
  });

  return { server, store };
}
