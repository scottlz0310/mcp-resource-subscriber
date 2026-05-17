import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

// Default URI for the bundled reference server (test://review/status)
const REVIEW_STATUS_URI = "test://review/status";

export interface SubscribeProbeOptions {
  url: string;
  uri?: string;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  /** Extra HTTP headers to include in every request (e.g. Authorization).
   * Keys and values must be valid HTTP header names/values; invalid values
   * will cause the underlying transport to throw at request time.
   */
  requestHeaders?: Record<string, string>;
  /**
   * When true, skip the resources/list check and assume the URI exists.
   * Useful for servers that support dynamic resources not returned by
   * resources/list (e.g. copilot-review-mcp watch URIs).
   */
  skipResourceListCheck?: boolean;
}

export interface SubscribeProbeResult {
  capabilities: unknown;
  resourceFound: boolean;
  initialText: string;
  notificationUri: string;
  finalText: string;
  notificationCount: number;
  /**
   * How the probe completed:
   * - "subscription"     — received notifications/resources/updated, then re-read
   * - "pre-completion"   — post-subscribe read detected the resource was already
   *                        updated (race: notification fired before subscribe)
   * - "timeout"          — notification never arrived within timeoutMs
   */
  route: "subscription" | "pre-completion" | "timeout";
  subscribed: boolean;
  unsubscribed: boolean;
  errorCode: string | null;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const RESOURCE_UPDATED_METHOD = "notifications/resources/updated";
const NON_TERMINAL_RECOMMENDED_ACTIONS = new Set(["POLL_AFTER"]);

function getResourceText(result: Awaited<ReturnType<Client["readResource"]>>): string {
  const first = result.contents[0];
  if (!first || !("text" in first)) {
    throw new Error("Expected text resource content");
  }

  return first.text;
}

interface ResourceUpdateEvent {
  sequence: number;
  uri: string;
}

interface ResourceUpdateQueue {
  readonly receivedCount: number;
  readonly lastUri: string;
  readonly waitAfter: (sequence: number, timeoutMs: number) => Promise<ResourceUpdateEvent>;
  readonly cancel: () => void;
}

function createResourceUpdateQueue(client: Client, uri: string): ResourceUpdateQueue {
  const events: ResourceUpdateEvent[] = [];
  let receivedCount = 0;
  let lastUri = "";
  let pending: {
    afterSequence: number;
    resolve: (event: ResourceUpdateEvent) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  } | null = null;

  const findNextEvent = (sequence: number): ResourceUpdateEvent | undefined =>
    events.find((event) => event.sequence > sequence);

  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
    if (notification.params.uri !== uri) {
      return;
    }

    receivedCount++;
    lastUri = notification.params.uri;
    const event = { sequence: receivedCount, uri: notification.params.uri };
    events.push(event);

    if (events.length > 100) {
      events.shift();
    }

    if (pending && event.sequence > pending.afterSequence) {
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  });

  return {
    get receivedCount(): number {
      return receivedCount;
    },
    get lastUri(): string {
      return lastUri;
    },
    waitAfter: (sequence: number, timeoutMs: number): Promise<ResourceUpdateEvent> => {
      const existing = findNextEvent(sequence);
      if (existing) {
        return Promise.resolve(existing);
      }

      if (timeoutMs <= 0) {
        return Promise.reject(new Error("Timed out waiting for resource update notification"));
      }

      return new Promise<ResourceUpdateEvent>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (pending?.reject === reject) {
            pending = null;
          }
          reject(new Error(`Timed out waiting for resource update notification after ${timeoutMs} ms`));
        }, timeoutMs);

        pending = {
          afterSequence: sequence,
          resolve,
          reject,
          timeout,
        };
      });
    },
    cancel: () => {
      if (pending) {
        clearTimeout(pending.timeout);
        pending = null;
      }
      client.removeNotificationHandler(RESOURCE_UPDATED_METHOD);
    },
  };
}

export function extractRecommendedAction(text: string): string | null {
  const parsed = parseJson(text);
  if (parsed !== null) {
    const fromJson = findRecommendedAction(parsed);
    if (fromJson) {
      return fromJson;
    }
  }

  const match =
    text.match(/(?:^|[\s,{])recommended_next_action\s*[:=]\s*"?([^"\s,}]+)"?/m) ??
    text.match(/"recommended_next_action"\s*:\s*"([^"]+)"/);
  return match ? (match[1] ?? null) : null;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function findRecommendedAction(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.recommended_next_action === "string") {
    return record.recommended_next_action;
  }

  for (const child of Object.values(record)) {
    const action = findRecommendedAction(child);
    if (action) {
      return action;
    }
  }

  return null;
}

function shouldWaitForNextUpdate(text: string): boolean {
  const action = extractRecommendedAction(text);
  return action !== null && NON_TERMINAL_RECOMMENDED_ACTIONS.has(action);
}

export async function runSubscribeProbe(options: SubscribeProbeOptions): Promise<SubscribeProbeResult> {
  const uri = options.uri ?? REVIEW_STATUS_URI;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({
    name: options.clientName ?? "mcp-resource-subscribe-probe-client",
    version: options.clientVersion ?? "0.1.2",
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.requestHeaders ? { headers: options.requestHeaders } : undefined,
    });
    await client.connect(transport);

    const capabilities = client.getServerCapabilities()?.resources ?? null;
    let resourceFound: boolean;
    if (options.skipResourceListCheck) {
      resourceFound = true;
    } else {
      const resources = await client.listResources();
      resourceFound = resources.resources.some((resource) => resource.uri === uri);
      if (!resourceFound) {
        return {
          capabilities,
          resourceFound: false,
          initialText: "",
          notificationUri: "",
          finalText: "",
          notificationCount: 0,
          route: "timeout",
          subscribed: false,
          unsubscribed: false,
          errorCode: "RESOURCE_NOT_FOUND",
        };
      }
    }

    const initial = await client.readResource({ uri });
    const initialText = getResourceText(initial);
    const notifications = createResourceUpdateQueue(client, uri);
    let subscribed = false;
    let unsubscribed = false;
    let notificationUri = "";
    let notificationSequence = 0;
    let finalText = "";
    let errorCode: string | null = null;
    let route: "subscription" | "pre-completion" | "timeout" = "timeout";
    const deadlineMs = Date.now() + timeoutMs;

    const remainingMs = (): number => Math.max(0, deadlineMs - Date.now());

    try {
      await client.subscribeResource({ uri });
      subscribed = true;
    } catch {
      notifications.cancel();
      return {
        capabilities,
        resourceFound: true,
        initialText,
        notificationUri: "",
        finalText: "",
        notificationCount: 0,
        route: "timeout",
        subscribed: false,
        unsubscribed: false,
        errorCode: "SUBSCRIPTION_FAILED",
      };
    }

    // Wrap all post-subscribe operations in a single try/finally so that
    // notifications.cancel() and unsubscribeResource() always run — even when
    // the post-subscribe read (pre-completion check) or the final read throws.
    try {
      const postSubscribeReadAfterSequence = notifications.receivedCount;
      // Immediately read once after subscribe to handle the pre-completion race condition:
      // if the resource was already updated before our subscription was established
      // (i.e., the notification fired before we subscribed), we will never receive
      // that notification. Comparing with initialText detects this window.
      const postSubscribeText = getResourceText(await client.readResource({ uri }));
      notificationSequence = postSubscribeReadAfterSequence;
      if (postSubscribeText !== initialText) {
        finalText = postSubscribeText;
        if (notifications.receivedCount > postSubscribeReadAfterSequence) {
          route = "subscription";
          notificationUri = notifications.lastUri;
        } else if (!shouldWaitForNextUpdate(finalText)) {
          route = "pre-completion";
        }

        while (shouldWaitForNextUpdate(finalText) && !errorCode) {
          try {
            const event = await notifications.waitAfter(notificationSequence, remainingMs());
            notificationSequence = event.sequence;
            notificationUri = event.uri;
            route = "subscription";
          } catch {
            errorCode = "NOTIFICATION_TIMEOUT";
            break;
          }

          finalText = getResourceText(await client.readResource({ uri }));
        }
      } else {
        try {
          const event = await notifications.waitAfter(notificationSequence, remainingMs());
          notificationSequence = event.sequence;
          notificationUri = event.uri;
          route = "subscription";
        } catch {
          errorCode = "NOTIFICATION_TIMEOUT";
        }

        if (route === "subscription") {
          finalText = getResourceText(await client.readResource({ uri }));
          while (shouldWaitForNextUpdate(finalText) && !errorCode) {
            try {
              const event = await notifications.waitAfter(notificationSequence, remainingMs());
              notificationSequence = event.sequence;
              notificationUri = event.uri;
            } catch {
              errorCode = "NOTIFICATION_TIMEOUT";
              break;
            }

            finalText = getResourceText(await client.readResource({ uri }));
          }
        }
      }
    } finally {
      notifications.cancel();
      try {
        await client.unsubscribeResource({ uri });
        unsubscribed = true;
      } catch {
        // ignore unsubscribe errors
      }
    }

    return {
      capabilities,
      resourceFound: true,
      initialText,
      notificationUri,
      finalText,
      notificationCount: notifications.receivedCount,
      route,
      subscribed,
      unsubscribed,
      errorCode,
    };
  } finally {
    await client.close();
  }
}
