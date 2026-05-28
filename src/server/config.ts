export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface TestConfig {
  port: number;
  mcpPath: string;
  updateDelaySeconds: number;
  initialStatus: string;
  updatedStatus: string;
  sendListChanged: boolean;
  logLevel: LogLevel;
}

export const DEFAULT_CONFIG: TestConfig = {
  port: 8089,
  mcpPath: "/mcp",
  updateDelaySeconds: 5,
  initialStatus: "pending",
  updatedStatus: "reviewed",
  sendListChanged: false,
  logLevel: "debug",
};

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
    return value;
  }

  return DEFAULT_CONFIG.logLevel;
}

function parseMcpPath(value: string | undefined, fallback: string): string {
  if (!value || value.trim() === "") {
    return fallback;
  }
  let path = value.trim();
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  path = path.replace(/\/+$/, "");
  return path === "" ? fallback : path;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): TestConfig {
  return {
    port: parseNumber(env.MCP_TEST_PORT, DEFAULT_CONFIG.port),
    mcpPath: parseMcpPath(env.MCP_TEST_PATH, DEFAULT_CONFIG.mcpPath),
    updateDelaySeconds: parseNumber(env.MCP_TEST_UPDATE_DELAY_SECONDS, DEFAULT_CONFIG.updateDelaySeconds),
    initialStatus: env.MCP_TEST_INITIAL_STATUS ?? DEFAULT_CONFIG.initialStatus,
    updatedStatus: env.MCP_TEST_UPDATED_STATUS ?? DEFAULT_CONFIG.updatedStatus,
    sendListChanged: parseBoolean(env.MCP_TEST_SEND_LIST_CHANGED, DEFAULT_CONFIG.sendListChanged),
    logLevel: parseLogLevel(env.MCP_TEST_LOG_LEVEL),
  };
}
