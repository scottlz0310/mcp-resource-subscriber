import {
  type DeviceAuthorization,
  discoverEndpoints,
  type FetchLike,
  OAuthRequestError,
  type PollOptions,
  pollDeviceToken,
  refreshTokenGrant,
  registerClient,
  requestDeviceAuthorization,
} from "./oauthClient.js";
import { LockTimeoutError, type TokenStore } from "./tokenStore.js";

/** Refresh the access token this long before it actually expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/**
 * The cached credentials cannot be renewed unattended (refresh token missing,
 * expired, or revoked) — the user must run `--login` again.
 */
export class AuthLoginRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthLoginRequiredError";
  }
}

/**
 * `resolveCachedToken` did not complete (endpoint discovery + refresh grant)
 * within its `timeoutMs` budget — the gateway likely accepted the TCP
 * connection but never responded. Distinct from `AuthLoginRequiredError`:
 * the cached credentials may still be valid, so a plain retry is reasonable.
 */
export class AuthTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthTimeoutError";
  }
}

// AbortSignal.timeout() fires with a "TimeoutError" DOMException, not
// "AbortError" (that name is reserved for manual AbortController.abort()).
// fetch() throws (or the discoverEndpoints wrapper re-wraps, preserving it
// as `cause`) whatever the signal's `reason` was.
function isAbortError(error: unknown): boolean {
  const isAbortDomException = (value: unknown): boolean =>
    value instanceof DOMException && (value.name === "AbortError" || value.name === "TimeoutError");
  if (isAbortDomException(error)) {
    return true;
  }
  return error instanceof Error && isAbortDomException(error.cause);
}

export type AuthSource = "cache" | "cache-refreshed" | "none";

export interface ResolvedAuth {
  token: string | null;
  source: AuthSource;
}

export interface GatewayAuthOptions extends PollOptions {
  fetchFn?: FetchLike;
  /**
   * Overall budget (ms) for everything `resolveCachedToken` does once a
   * refresh is needed: waiting for the cross-process refresh lock *and* the
   * network calls (endpoint discovery + refresh grant). Undefined means no
   * deadline. Exceeding it raises `AuthTimeoutError` instead of hanging
   * indefinitely.
   */
  timeoutMs?: number;
}

export interface LoginResult {
  origin: string;
  /** Epoch milliseconds when the new access token expires. */
  expiresAt: number;
}

/**
 * Runs the full interactive login: DCR (reusing a cached client_id when one
 * exists) → device authorization → user approval wait → token persistence.
 * `onVerification` fires once the user_code / verification_uri are known so
 * the CLI can prompt the user while polling continues.
 */
export async function loginToGateway(
  url: string,
  store: TokenStore,
  onVerification: (auth: DeviceAuthorization) => void,
  options: GatewayAuthOptions = {},
): Promise<LoginResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const origin = new URL(url).origin;
  const endpoints = await discoverEndpoints(origin, fetchFn);
  const clientId = store.get(origin)?.clientId ?? (await registerClient(endpoints, fetchFn));
  const deviceAuth = await requestDeviceAuthorization(endpoints, clientId, fetchFn);
  onVerification(deviceAuth);
  const tokens = await pollDeviceToken(endpoints, clientId, deviceAuth, options);
  store.save({
    origin,
    clientId,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return { origin, expiresAt: tokens.expiresAt };
}

/**
 * Resolves a usable access token from the cache for the given server URL:
 * returns it as-is while still fresh (with a safety margin), refreshes it
 * unattended when expired, and reports `none` when this origin has never been
 * logged in. Explicit tokens (--auth-token / MCP_PROBE_AUTH_TOKEN) must be
 * handled by the caller before consulting the cache — they always win.
 *
 * Throws AuthLoginRequiredError when refresh is impossible (no refresh token
 * or invalid_grant); other errors (network, gateway 5xx) propagate so callers
 * can distinguish "re-login needed" from "retry later".
 */
export async function resolveCachedToken(
  url: string,
  store: TokenStore,
  options: GatewayAuthOptions = {},
): Promise<ResolvedAuth> {
  const fetchFn = options.fetchFn ?? fetch;
  const nowFn = options.nowFn ?? Date.now;
  const origin = new URL(url).origin;
  const cached = store.get(origin);
  if (!cached) {
    return { token: null, source: "none" };
  }
  if (cached.expiresAt - EXPIRY_MARGIN_MS > nowFn()) {
    return { token: cached.accessToken, source: "cache" };
  }
  if (!cached.refreshToken) {
    throw new AuthLoginRequiredError(
      `cached access token for ${origin} is expired and no refresh token is available; run --login again`,
    );
  }

  // resolveCachedToken runs outside the caller's own request timeout (it
  // happens before runSubscribeProbe even connects), so without its own
  // budget a gateway that accepts the TCP connection but never responds
  // would hang for undici's default headers timeout (~300s). The deadline
  // is computed now (before lock acquisition) so BEGIN IMMEDIATE's
  // synchronous, potentially multi-second wait for a concurrent refresh
  // also counts against it — the AbortSignal below is created from what's
  // left afterward, not a fresh timeoutMs.
  const deadline = options.timeoutMs !== undefined ? nowFn() + options.timeoutMs : undefined;

  try {
    // The gateway revokes a refresh token's entire rotation family once a
    // consumed token is re-presented, so a concurrent probe cannot safely
    // recover after the fact by adopting whatever the winner last saved — its
    // *next* refresh would still fail. Serialize refreshes for this origin
    // across processes instead: only the lock holder may present a refresh
    // token to the gateway, and every waiter re-reads the store once it
    // acquires the lock, skipping the network call if another process
    // already refreshed in the meantime.
    return await store.withExclusiveLock(async () => {
      let signal: AbortSignal | undefined;
      if (deadline !== undefined) {
        const remainingMs = deadline - nowFn();
        if (remainingMs <= 0) {
          // Lock acquisition alone consumed the whole budget — fail the
          // same way a network-call timeout would rather than starting a
          // network call with an already-expired signal.
          throw new AuthTimeoutError(
            `auth resolution for ${origin} did not complete within the ${options.timeoutMs} ms budget (lock acquisition consumed it)`,
          );
        }
        signal = AbortSignal.timeout(remainingMs);
      }

      const latest = store.get(origin);
      if (!latest) {
        throw new AuthLoginRequiredError(
          `cached access token for ${origin} is expired and no refresh token is available; run --login again`,
        );
      }
      if (latest.expiresAt - EXPIRY_MARGIN_MS > nowFn()) {
        return { token: latest.accessToken, source: "cache-refreshed" };
      }
      if (!latest.refreshToken) {
        throw new AuthLoginRequiredError(
          `cached access token for ${origin} is expired and no refresh token is available; run --login again`,
        );
      }
      const endpoints = await discoverEndpoints(origin, fetchFn, signal);
      let tokens: Awaited<ReturnType<typeof refreshTokenGrant>>;
      try {
        tokens = await refreshTokenGrant(endpoints, latest.clientId, latest.refreshToken, fetchFn, signal);
      } catch (error) {
        if (error instanceof OAuthRequestError && error.oauthError === "invalid_grant") {
          throw new AuthLoginRequiredError(
            `gateway ${origin} rejected the cached refresh token (invalid_grant); run --login again`,
            { cause: error },
          );
        }
        throw error;
      }
      store.save({
        origin,
        clientId: latest.clientId,
        accessToken: tokens.accessToken,
        // The gateway rotates refresh tokens; keep the old one only if the
        // response omitted a replacement.
        refreshToken: tokens.refreshToken ?? latest.refreshToken,
        expiresAt: tokens.expiresAt,
      });
      return { token: tokens.accessToken, source: "cache-refreshed" };
    }, options.timeoutMs);
  } catch (error) {
    if (isAbortError(error) || error instanceof LockTimeoutError) {
      throw new AuthTimeoutError(
        `auth resolution for ${origin} did not complete within the ${options.timeoutMs} ms budget`,
        { cause: error },
      );
    }
    throw error;
  }
}
