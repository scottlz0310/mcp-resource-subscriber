import { Client, type McpSubscription, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { connectPinned, PINNED_CLIENT_OPTIONS } from "./protocolNegotiation.js";
import {
  classifyWaitFailure,
  createResourceUpdateQueue,
  getResourceText,
  type ResourceSubscriptionOptions,
  SubscriptionClosedError,
  UNCACHED,
} from "./subscriptionClient.js";
import { evaluateUntil, type UntilCondition } from "./untilCondition.js";

export type StreamEvent =
  | { type: "ack"; resourceUri: string; honoredUris: string[] }
  | {
      type: "snapshot";
      source: "post-listen" | "notification";
      notificationUri: string | null;
      text: string;
      json: unknown | null;
      matched: boolean;
    };

export interface ResourceStreamOptions extends ResourceSubscriptionOptions {
  until: UntilCondition;
  /** ack・snapshot は到着の都度同期的に呼ばれる。終了時の end は戻り値から呼び出し元が組み立てる。 */
  onEvent: (event: StreamEvent) => void;
}

export interface ResourceStreamResult {
  listenAcknowledged: boolean;
  honoredUris: string[];
  closeReason: "local" | "graceful" | "remote" | null;
  errorCode: string | null;
  notificationCount: number;
  matched: boolean;
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * 終了条件が一致するまで更新を逐次配送する。`runResourceSubscription` と違い、
 * ack 後の現在値 read を必ず出力する（listen 前に確定済みの結果もここで検出する）。
 * 終了条件の判定は `--until` の機械的な一致のみで、PR/HEAD/Verdict は解釈しない。
 */
export async function runResourceStream(options: ResourceStreamOptions): Promise<ResourceStreamResult> {
  const { uri, until, onEvent } = options;
  const deadlineMs = Date.now() + (options.timeoutMs ?? 15_000);
  const remainingMs = (): number => Math.max(0, deadlineMs - Date.now());
  const client = new Client(
    {
      name: options.clientName ?? "resource-bridge-cli",
      version: options.clientVersion ?? "0.0.0",
    },
    PINNED_CLIENT_OPTIONS,
  );

  const failed = (errorCode: string, ack: { listenAcknowledged: boolean; honoredUris: string[] }) => ({
    ...ack,
    closeReason: null,
    errorCode,
    notificationCount: 0,
    matched: false,
  });
  const notAcknowledged = { listenAcknowledged: false, honoredUris: [] };

  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.requestHeaders ? { headers: options.requestHeaders } : undefined,
    });
    await connectPinned(client, transport);

    if (!options.skipResourceListCheck) {
      const resources = await client.listResources(undefined, UNCACHED);
      if (!resources.resources.some((resource) => resource.uri === uri)) {
        return failed("RESOURCE_NOT_FOUND", notAcknowledged);
      }
    }

    // 通知ハンドラは listen より前に登録する。ack 直後の通知を取りこぼさないため。
    const notifications = createResourceUpdateQueue(client, uri);

    let subscription: McpSubscription;
    try {
      subscription = await client.listen({ resourceSubscriptions: [uri] }, { timeout: remainingMs() });
    } catch {
      notifications.cancel();
      return failed("SUBSCRIPTION_FAILED", notAcknowledged);
    }

    const honoredUris = subscription.honoredFilter.resourceSubscriptions ?? [];
    let closeReason: ResourceStreamResult["closeReason"] = null;
    void subscription.closed.then((reason) => {
      closeReason = reason;
      if (reason !== "local") {
        notifications.fail(new SubscriptionClosedError(reason));
      }
    });
    onEvent({ type: "ack", resourceUri: uri, honoredUris });

    if (!honoredUris.includes(uri)) {
      await subscription.close().catch(() => undefined);
      notifications.cancel();
      return { ...failed("SUBSCRIPTION_NOT_HONORED", { listenAcknowledged: true, honoredUris }), closeReason };
    }

    let errorCode: string | null = null;
    let matched = false;
    try {
      // 現在値の read より前の通知件数を控える。read 中に届いた通知は次の待機で拾う。
      let sequence = notifications.receivedCount;
      let source: "post-listen" | "notification" = "post-listen";
      let notificationUri: string | null = null;

      for (;;) {
        const text = getResourceText(await client.readResource({ uri }, UNCACHED));
        const json = parseJson(text);
        matched = evaluateUntil(until, json);
        onEvent({ type: "snapshot", source, notificationUri, text, json, matched });
        if (matched) {
          break;
        }

        try {
          const event = await notifications.waitAfter(sequence, remainingMs());
          notificationUri = event.uri;
        } catch (error) {
          errorCode = classifyWaitFailure(error);
          break;
        }
        // 合流した通知は次の read でまとめて反映されるため、待機位置を現在の受信数まで進める。
        sequence = notifications.receivedCount;
        source = "notification";
      }
    } finally {
      notifications.cancel();
      await subscription.close().catch(() => undefined);
    }

    return {
      listenAcknowledged: true,
      honoredUris,
      closeReason,
      errorCode,
      notificationCount: notifications.receivedCount,
      matched,
    };
  } finally {
    await client.close();
  }
}
