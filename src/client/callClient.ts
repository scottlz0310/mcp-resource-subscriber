import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface ToolCallOptions {
  url: string;
  tool: string;
  args?: Record<string, unknown>;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
  /** Extra HTTP headers to include in every request (e.g. Authorization).
   * Keys and values must be valid HTTP header names/values; invalid values
   * will cause the underlying transport to throw at request time.
   */
  requestHeaders?: Record<string, string>;
}

export interface ToolCallResult {
  content: unknown;
  isError: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export async function runToolCall(options: ToolCallOptions): Promise<ToolCallResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new Client({
    name: options.clientName ?? "mcp-resource-subscribe-call-client",
    version: options.clientVersion ?? "0.3.0",
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: options.requestHeaders ? { headers: options.requestHeaders } : undefined,
    });
    await client.connect(transport);

    const result = await client.callTool({ name: options.tool, arguments: options.args ?? {} }, undefined, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });

    return {
      content: result.content ?? [],
      isError: result.isError === true,
    };
  } finally {
    await client.close();
  }
}
