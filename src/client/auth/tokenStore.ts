import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** One cached token set per gateway origin (e.g. http://127.0.0.1:8080). */
export interface StoredToken {
  origin: string;
  /** DCR-issued client_id, reused across logins so we do not re-register every time. */
  clientId: string | null;
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number;
}

export interface TokenStore {
  get(origin: string): StoredToken | null;
  save(token: StoredToken): void;
  delete(origin: string): void;
  close(): void;
  /**
   * Runs `fn` while holding a cross-process exclusive lock (SQLite
   * `BEGIN IMMEDIATE`), so only one process at a time can be mid-refresh for
   * this store. Callers must re-read the store after acquiring the lock:
   * another process may have already refreshed while this one was waiting.
   */
  withExclusiveLock<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Resolves the token store path following the same OS state-dir convention as
 * mcp-gateway (Windows: %LOCALAPPDATA%, macOS: Application Support, Linux:
 * $XDG_STATE_HOME with ~/.local/state fallback).
 */
export function defaultTokenStorePath(): string {
  const override = process.env.MCP_PROBE_TOKEN_STORE_PATH;
  if (override) {
    return override;
  }
  const home = homedir();
  switch (process.platform) {
    case "win32": {
      const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
      return join(base, "mcp-resource-subscriber", "tokens.db");
    }
    case "darwin":
      return join(home, "Library", "Application Support", "mcp-resource-subscriber", "tokens.db");
    default: {
      const base = process.env.XDG_STATE_HOME ?? join(home, ".local", "state");
      return join(base, "mcp-resource-subscriber", "tokens.db");
    }
  }
}

/**
 * True when a token store database already exists. Callers that only read
 * (the probe path) should check this first so runs that never logged in do
 * not create the database as a side effect.
 */
export function tokenStoreExists(dbPath: string = defaultTokenStorePath()): boolean {
  return existsSync(dbPath);
}

interface TokenRow {
  origin: string;
  client_id: string | null;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
}

export function openTokenStore(dbPath: string = defaultTokenStorePath()): TokenStore {
  try {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Failed to create token store directory for ${dbPath}: ${String(error)}`, { cause: error });
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    // Tokens are credentials: keep the DB readable by the owning user only
    // (no-op on Windows, where %LOCALAPPDATA% ACLs already scope to the user).
    chmodSync(dbPath, 0o600);
    // Concurrent CLI invocations may share this DB; wait for locks instead of
    // failing immediately with SQLITE_BUSY.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        origin TEXT PRIMARY KEY,
        client_id TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
  } catch (error) {
    throw new Error(`Failed to open token store at ${dbPath}: ${String(error)}`, { cause: error });
  }

  return {
    get(origin: string): StoredToken | null {
      const row = db
        .prepare("SELECT origin, client_id, access_token, refresh_token, expires_at FROM tokens WHERE origin = ?")
        .get(origin) as TokenRow | undefined;
      if (!row) {
        return null;
      }
      return {
        origin: row.origin,
        clientId: row.client_id,
        accessToken: row.access_token,
        refreshToken: row.refresh_token,
        expiresAt: row.expires_at,
      };
    },
    save(token: StoredToken): void {
      db.prepare(
        `INSERT INTO tokens (origin, client_id, access_token, refresh_token, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin) DO UPDATE SET
           client_id = excluded.client_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      ).run(token.origin, token.clientId, token.accessToken, token.refreshToken, token.expiresAt, Date.now());
    },
    delete(origin: string): void {
      db.prepare("DELETE FROM tokens WHERE origin = ?").run(origin);
    },
    close(): void {
      db.close();
    },
    async withExclusiveLock<T>(fn: () => Promise<T>): Promise<T> {
      // BEGIN IMMEDIATE acquires SQLite's RESERVED lock up front (waiting up
      // to busy_timeout for other processes to release it), so it serializes
      // concurrent probes across processes rather than just within this one.
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Connection may already be out of a transaction (e.g. closed).
        }
        throw error;
      }
    },
  };
}
