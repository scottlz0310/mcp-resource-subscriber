import type { ToolCallResult } from "./callClient.js";

export interface CallJsonOutput {
  serverUrl: string | null;
  tool: string | null;
  isError: boolean;
  errorCode: string | null;
  content: unknown;
}

export function buildCallJsonOutput(result: ToolCallResult, serverUrl: string, tool: string): CallJsonOutput {
  return {
    serverUrl,
    tool,
    isError: result.isError,
    errorCode: result.isError ? "TOOL_ERROR" : null,
    content: result.content,
  };
}

export function buildCallErrorJsonOutput(
  errorCode: string,
  serverUrl: string | null,
  tool: string | null,
): CallJsonOutput {
  return {
    serverUrl,
    tool,
    isError: true,
    errorCode,
    content: null,
  };
}
