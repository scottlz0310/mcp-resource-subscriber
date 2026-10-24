import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createMcpHttpApp } from "../../src/server/httpServer.js";

export interface TestServer {
  url: string;
  close: () => Promise<void>;
  /** 接続を応答なしで切る。listen stream の異常切断（closeReason=remote）を再現する。 */
  dropConnections: () => void;
}

export async function startTestServer(updateDelaySeconds = 0.05, readDelayMs?: number): Promise<TestServer> {
  const { app, close: closeHandler } = createMcpHttpApp(
    {
      port: 0,
      mcpPath: "/mcp",
      updateDelaySeconds,
      initialStatus: "pending",
      updatedStatus: "reviewed",
      sendListChanged: false,
      readDelayMs,
      logLevel: "silent",
    },
    () => {},
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      server.closeAllConnections();
      await closeHandler();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
    dropConnections: () => server.closeAllConnections(),
  };
}
