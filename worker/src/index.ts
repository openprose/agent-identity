// agent-identity token broker.
//
// Holds the GitHub App private key and is the only place that can mint
// installation tokens. Team members log in once per machine through the
// browser; agents then exchange that session for one-hour, narrowed tokens.

import {
  appJwt,
  parseDefaultAccess,
  parseMaxPermissions,
  sha256Base64,
  importAppKey,
  randomToken,
  sha256Hex,
  timingSafeEqual,
  validateMintRequest,
} from "./lib";

export interface Env {
  STATE: KVNamespace;
  MINT_LIMIT: RateLimit;
  LOGIN_LIMIT: RateLimit;
  GITHUB_ORG: string;
  GITHUB_TEAM: string;
  // Optional JSON object capping minted permissions; see lib.ts.
  MAX_PERMISSIONS?: string;
  // "read" (default): requests that name no permissions get read-only tokens.
  // "ceiling": they get the full ceiling (the behaviour of older CLIs).
  DEFAULT_ACCESS?: string;
  APP_ID?: string;
  APP_CLIENT_ID?: string;
  APP_SLUG?: string;
  APP_PRIVATE_KEY?: string;
  APP_CLIENT_SECRET?: string;
}

const GITHUB_API = "https://api.github.com";
// Bump with each template release; `agent-identity doctor` compares it.
export const TEMPLATE_VERSION = "0.2.1";
const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const LOGIN_TTL_SECONDS = 600;
const MEMBERSHIP_CACHE_SECONDS = 300;
const AUDIT_TTL_SECONDS = 400 * 24 * 3600;
const MAX_CODE_ATTEMPTS = 5;
// Note: KV is eventually consistent, so attempt counts and revocations are
// best-effort across regions (revocation can take up to ~60s to propagate).

type LoginRecord = {
  poll_hash: string;
  redirect_port: number;
  device: string;
  created_at: string;
  status: "pending" | "authorized" | "denied";
  login?: string;
  user_id?: number;
  code_hash?: string;
  attempts: number;
  denied_reason?: string;
};

type SessionRecord = {
  login: string;
  user_id: number;
  device: string;
  created_at: string;
  expires_at: string;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem}
code.big{display:block;font-size:2.2rem;letter-spacing:.15em;margin:1.5rem 0;font-weight:600}</style>
<h1>${escapeHtml(title)}</h1>${body}`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}

function configured(env: Env): boolean {
  return Boolean(env.APP_ID && env.APP_CLIENT_ID && env.APP_PRIVATE_KEY && env.APP_CLIENT_SECRET);
}

function requireConfigured(env: Env): void {
  if (!configured(env)) throw new HttpError(503, "broker is not configured yet");
}

async function readJson(request: Request): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16_384) throw new HttpError(413, "request body too large");
  // Chunked bodies carry no content-length: stream, and stop at the cap.
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new HttpError(413, "request body too large");
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

async function github(path: string, token: string, init: RequestInit = {}, scheme = "Bearer"): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agent-identity-broker",
      authorization: `${scheme} ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

// ---- App credentials (per-isolate caches; nothing secret goes to KV) ----

let keyCache: { pem: string; key: CryptoKey } | undefined;
let installationIdCache: number | undefined;
let membersTokenCache: { token: string; expiresAt: number } | undefined;

async function jwt(env: Env): Promise<string> {
  requireConfigured(env);
  if (!keyCache || keyCache.pem !== env.APP_PRIVATE_KEY) {
    keyCache = { pem: env.APP_PRIVATE_KEY!, key: await importAppKey(env.APP_PRIVATE_KEY!) };
  }
  return appJwt(keyCache.key, env.APP_CLIENT_ID!);
}

async function installationId(env: Env): Promise<number> {
  if (installationIdCache) return installationIdCache;
  const response = await github(`/orgs/${env.GITHUB_ORG}/installation`, await jwt(env));
  if (!response.ok) {
    throw new HttpError(503, `the app is not installed on ${env.GITHUB_ORG} (GitHub ${response.status})`);
  }
  installationIdCache = ((await response.json()) as { id: number }).id;
  return installationIdCache;
}

// The installation's granted permissions, so a request never asks for more
// than the org has accepted (GitHub refuses the whole token otherwise).
let grantedCache: { permissions: Record<string, string>; at: number } | undefined;

async function grantedPermissions(env: Env): Promise<Record<string, string>> {
  if (grantedCache && Date.now() - grantedCache.at < 5 * 60_000) return grantedCache.permissions;
  const response = await github(`/app/installations/${await installationId(env)}`, await jwt(env));
  if (!response.ok) throw new HttpError(502, `could not read the installation (GitHub ${response.status})`);
  const permissions = ((await response.json()) as { permissions: Record<string, string> }).permissions;
  grantedCache = { permissions, at: Date.now() };
  return permissions;
}

const RANK: Record<string, number> = { read: 1, write: 2 };

async function createInstallationToken(
  env: Env,
  body: { repositories?: string[]; permissions: Record<string, string> },
): Promise<{ token: string; expires_at: string; permissions: Record<string, string>; repositories?: { name: string }[] }> {
  const id = await installationId(env);
  const response = await github(`/app/installations/${id}/access_tokens`, await jwt(env), {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = ((await response.json().catch(() => ({}))) as { message?: string }).message ?? "";
    throw new HttpError(response.status === 422 ? 422 : 502, `GitHub refused the token request: ${detail || response.status}`);
  }
  return response.json();
}

async function membersToken(env: Env): Promise<string> {
  if (membersTokenCache && membersTokenCache.expiresAt - Date.now() > 5 * 60_000) return membersTokenCache.token;
  const minted = await createInstallationToken(env, { permissions: { members: "read" } });
  membersTokenCache = { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
  return minted.token;
}

async function isTeamMember(env: Env, login: string, useCache = true): Promise<boolean> {
  const cacheKey = `member:${login.toLowerCase()}`;
  if (useCache && (await env.STATE.get(cacheKey)) === "active") return true;
  const response = await github(
    `/orgs/${env.GITHUB_ORG}/teams/${env.GITHUB_TEAM}/memberships/${encodeURIComponent(login)}`,
    await membersToken(env),
  );
  if (response.status === 404) return false;
  if (!response.ok) throw new HttpError(502, `team membership check failed (GitHub ${response.status})`);
  const active = ((await response.json()) as { state?: string }).state === "active";
  if (active) await env.STATE.put(cacheKey, "active", { expirationTtl: MEMBERSHIP_CACHE_SECONDS });
  return active;
}

// ---- Sessions ----

async function session(env: Env, request: Request): Promise<{ record: SessionRecord; key: string }> {
  const header = request.headers.get("authorization") ?? "";
  // The prefix only helps people and secret scanners recognize the token;
  // lookup is by sha256, so any short lowercase prefix is accepted.
  const match = /^Bearer ([a-z]{2,8}_[A-Za-z0-9_-]{20,})$/.exec(header);
  if (!match) throw new HttpError(401, "missing or malformed session token; run `agent-identity login`");
  const key = `session:${await sha256Hex(match[1])}`;
  const record = await env.STATE.get<SessionRecord>(key, "json");
  if (!record) throw new HttpError(401, "session expired or revoked; run `agent-identity login`");
  if (!(await isTeamMember(env, record.login))) {
    await revokeAllSessions(env, record.login);
    throw new HttpError(403, `${record.login} is no longer in ${env.GITHUB_ORG}/${env.GITHUB_TEAM}; sessions revoked`);
  }
  return { record, key };
}

const userSessionPrefix = (login: string) => `user-session:${login.toLowerCase()}:`;

async function revokeSession(env: Env, key: string, login: string): Promise<void> {
  const hash = key.slice("session:".length);
  await Promise.all([env.STATE.delete(key), env.STATE.delete(`${userSessionPrefix(login)}${hash}`)]);
}

async function revokeAllSessions(env: Env, login: string): Promise<number> {
  const listed = await env.STATE.list({ prefix: userSessionPrefix(login) });
  await Promise.all(
    listed.keys.map(async ({ name }) => {
      const hash = name.slice(userSessionPrefix(login).length);
      await Promise.all([env.STATE.delete(`session:${hash}`), env.STATE.delete(name)]);
    }),
  );
  return listed.keys.length;
}

async function listSessions(env: Env, login: string): Promise<SessionRecord[]> {
  const listed = await env.STATE.list({ prefix: userSessionPrefix(login) });
  const records = await Promise.all(listed.keys.map(({ name }) => env.STATE.get<SessionRecord>(name, "json")));
  return records.filter((r): r is SessionRecord => r !== null);
}

// ---- Login: CLI start -> browser via GitHub -> loopback redirect to the CLI ----
//
// The one-time code only ever travels to 127.0.0.1 on the machine whose
// browser completed the GitHub login, so a login link sent to someone else
// cannot deliver a code to whoever started it.

async function loginStart(env: Env, request: Request, origin: string): Promise<Response> {
  requireConfigured(env);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await env.LOGIN_LIMIT.limit({ key: ip })).success) throw new HttpError(429, "too many login attempts; wait a minute");
  const body = (await readJson(request)) as { poll_hash?: unknown; device?: unknown; redirect_port?: unknown };
  if (typeof body.poll_hash !== "string" || !/^[0-9a-f]{64}$/.test(body.poll_hash)) {
    throw new HttpError(400, "poll_hash must be a sha256 hex digest");
  }
  const port = body.redirect_port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new HttpError(400, "redirect_port must be the CLI's loopback port (1024-65535)");
  }
  const device =
    typeof body.device === "string" && /^[A-Za-z0-9._:@-]{1,64}$/.test(body.device) ? body.device : "unnamed";
  const loginId = randomToken("", 24);
  const record: LoginRecord = {
    poll_hash: body.poll_hash,
    redirect_port: port,
    device,
    created_at: new Date().toISOString(),
    status: "pending",
    attempts: 0,
  };
  await env.STATE.put(`login:${loginId}`, JSON.stringify(record), { expirationTtl: LOGIN_TTL_SECONDS });
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.APP_CLIENT_ID!);
  authorize.searchParams.set("state", loginId);
  authorize.searchParams.set("redirect_uri", `${origin}/v1/login/callback`);
  return json({ login_id: loginId, url: authorize.toString(), expires_in: LOGIN_TTL_SECONDS });
}

async function loginCallback(env: Env, url: URL, origin: string): Promise<Response> {
  requireConfigured(env);
  const loginId = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const key = `login:${loginId}`;
  const record = loginId ? await env.STATE.get<LoginRecord>(key, "json") : null;
  if (!record || record.status !== "pending" || !code) {
    return page("Login link expired", "<p>Run <code>agent-identity login</code> again.</p>", 400);
  }

  const exchange = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "agent-identity-broker" },
    body: JSON.stringify({
      client_id: env.APP_CLIENT_ID,
      client_secret: env.APP_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/v1/login/callback`,
    }),
  });
  const exchanged = (await exchange.json().catch(() => ({}))) as { access_token?: string };
  if (!exchanged.access_token) {
    return page("GitHub login failed", "<p>Run <code>agent-identity login</code> again.</p>", 502);
  }

  // The user token only proves identity. Read the login, then revoke it so
  // no GitHub user credential outlives this request.
  const userToken = exchanged.access_token;
  const userResponse = await github("/user", userToken);
  const user = userResponse.ok ? ((await userResponse.json()) as { login: string; id: number }) : null;
  const revoked = await github(`/applications/${env.APP_CLIENT_ID}/token`, btoa(`${env.APP_CLIENT_ID}:${env.APP_CLIENT_SECRET}`), {
    method: "DELETE",
    body: JSON.stringify({ access_token: userToken }),
  }, "Basic").catch(() => undefined);
  if (revoked?.status !== 204) {
    console.error(JSON.stringify({ event: "user_token_revoke_failed", status: revoked?.status ?? "network", login: user?.login }));
  }
  if (!user) return page("GitHub login failed", "<p>Could not read your GitHub account.</p>", 502);

  if (!(await isTeamMember(env, user.login, false))) {
    record.status = "denied";
    record.login = user.login;
    record.denied_reason = `${user.login} is not a member of ${env.GITHUB_ORG}/${env.GITHUB_TEAM}`;
    await env.STATE.put(key, JSON.stringify(record), { expirationTtl: LOGIN_TTL_SECONDS });
    console.log(JSON.stringify({ event: "login_denied", login: user.login, device: record.device }));
    return page("Not allowed", `<p>${escapeHtml(record.denied_reason)}.</p>`, 403);
  }

  const loopbackCode = randomToken("", 24);
  record.status = "authorized";
  record.login = user.login;
  record.user_id = user.id;
  record.code_hash = await sha256Hex(loopbackCode);
  await env.STATE.put(key, JSON.stringify(record), { expirationTtl: LOGIN_TTL_SECONDS });
  return new Response(null, {
    status: 303,
    headers: {
      location: `http://127.0.0.1:${record.redirect_port}/callback?code=${loopbackCode}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function loginFinish(env: Env, request: Request): Promise<Response> {
  const body = (await readJson(request)) as { login_id?: unknown; poll_secret?: unknown; code?: unknown };
  if (typeof body.login_id !== "string" || typeof body.poll_secret !== "string" || typeof body.code !== "string") {
    throw new HttpError(400, "login_id, poll_secret and code are required");
  }
  const key = `login:${body.login_id}`;
  const record = await env.STATE.get<LoginRecord>(key, "json");
  if (!record || !timingSafeEqual(await sha256Hex(body.poll_secret), record.poll_hash)) {
    throw new HttpError(404, "login not found or expired");
  }
  if (record.status === "denied") {
    await env.STATE.delete(key);
    throw new HttpError(403, record.denied_reason ?? "login denied");
  }
  if (record.status !== "authorized") throw new HttpError(409, "finish the GitHub login in the browser first");
  if (!timingSafeEqual(await sha256Hex(body.code), record.code_hash!)) {
    record.attempts += 1;
    if (record.attempts >= MAX_CODE_ATTEMPTS) await env.STATE.delete(key);
    else await env.STATE.put(key, JSON.stringify(record), { expirationTtl: LOGIN_TTL_SECONDS });
    throw new HttpError(403, "wrong code");
  }
  await env.STATE.delete(key);

  const token = randomToken("ais_");
  const now = new Date();
  const sessionRecord: SessionRecord = {
    login: record.login!,
    user_id: record.user_id!,
    device: record.device,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  const tokenHash = await sha256Hex(token);
  await Promise.all([
    env.STATE.put(`session:${tokenHash}`, JSON.stringify(sessionRecord), { expirationTtl: SESSION_TTL_SECONDS }),
    env.STATE.put(`${userSessionPrefix(sessionRecord.login)}${tokenHash}`, JSON.stringify(sessionRecord), {
      expirationTtl: SESSION_TTL_SECONDS,
    }),
  ]);
  console.log(JSON.stringify({ event: "session_created", login: sessionRecord.login, device: sessionRecord.device }));
  return json({ session_token: token, ...sessionRecord });
}

// ---- Minting ----

async function mint(env: Env, request: Request): Promise<Response> {
  requireConfigured(env);
  const { record, key } = await session(env, request);
  if (!(await env.MINT_LIMIT.limit({ key })).success) {
    throw new HttpError(429, "too many tokens minted by this session; reuse cached tokens (the CLI caches them)");
  }
  const validated = validateMintRequest(
    await readJson(request),
    parseMaxPermissions(env.MAX_PERMISSIONS),
    parseDefaultAccess(env.DEFAULT_ACCESS),
  );
  if ("error" in validated) throw new HttpError(400, validated.error);
  const granted = await grantedPermissions(env);
  for (const [name, level] of Object.entries(validated.permissions)) {
    const have = Object.hasOwn(granted, name) ? granted[name] : undefined;
    if (!have) delete validated.permissions[name];
    else if (RANK[level] > RANK[have]) validated.permissions[name] = have as "read" | "write";
  }

  const minted = await createInstallationToken(env, {
    ...(validated.repositories ? { repositories: validated.repositories } : {}),
    permissions: validated.permissions,
  });
  const audit = {
    event: "token_minted",
    at: new Date().toISOString(),
    login: record.login,
    device: record.device,
    ip: request.headers.get("cf-connecting-ip") ?? "unknown",
    label: validated.label,
    repositories: minted.repositories?.map((r) => r.name) ?? "all",
    permissions: minted.permissions,
    token_sha256: await sha256Hex(minted.token),
    // Joins GitHub's audit-log `hashed_token` field.
    token_sha256_b64: await sha256Base64(minted.token),
    expires_at: minted.expires_at,
  };
  console.log(JSON.stringify(audit));
  // Fail closed: a token without an audit record is revoked, never returned.
  // Newest-first keys so a plain prefix list returns recent entries.
  const newestFirst = String(9_999_999_999_999 - Date.now()).padStart(13, "0");
  try {
    await Promise.all([
      env.STATE.put(`audit:${newestFirst}:${audit.token_sha256.slice(0, 12)}`, JSON.stringify(audit), {
        expirationTtl: AUDIT_TTL_SECONDS,
      }),
      env.STATE.put(`audit-sha:${audit.token_sha256}`, JSON.stringify(audit), { expirationTtl: AUDIT_TTL_SECONDS }),
    ]);
  } catch (error) {
    const revoked = await github("/installation/token", minted.token, { method: "DELETE" }).catch(() => undefined);
    console.error(JSON.stringify({ event: "audit_write_failed", token_sha256: audit.token_sha256, revoked: revoked?.status === 204, message: String(error) }));
    throw new HttpError(503, "could not record the audit entry; the token was revoked");
  }
  return json({
    token: minted.token,
    expires_at: minted.expires_at,
    permissions: minted.permissions,
    repositories: audit.repositories,
    label: validated.label,
    login: record.login,
  });
}

async function auditList(env: Env, request: Request, url: URL): Promise<Response> {
  await session(env, request);
  const sha = url.searchParams.get("token_sha256");
  if (sha) {
    const entry = /^[0-9a-f]{64}$/.test(sha) ? await env.STATE.get(`audit-sha:${sha}`, "json") : null;
    return json({ entries: entry ? [entry] : [] });
  }
  const limit = Math.max(1, Math.min(Math.floor(Number(url.searchParams.get("limit") ?? "50")) || 50, 200));
  const listed = await env.STATE.list({ prefix: "audit:", limit });
  const entries = await Promise.all(listed.keys.map((k) => env.STATE.get(k.name, "json")));
  return json({ entries: entries.filter(Boolean) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const route = `${request.method} ${url.pathname}`;
    try {
      switch (route) {
        case "GET /health":
          return json({ ok: true, configured: configured(env), app: env.APP_SLUG ?? null, org: env.GITHUB_ORG });
        case "GET /version": {
          // Surfaces a bad MAX_PERMISSIONS / DEFAULT_ACCESS before anyone mints.
          let config: Record<string, unknown>;
          try {
            config = {
              max_permissions: parseMaxPermissions(env.MAX_PERMISSIONS),
              default_access: parseDefaultAccess(env.DEFAULT_ACCESS),
            };
          } catch (error) {
            config = { error: (error as Error).message };
          }
          return json({ version: TEMPLATE_VERSION, configured: configured(env), ...config });
        }
        case "POST /v1/login/start":
          return await loginStart(env, request, origin);
        case "GET /v1/login/callback":
          return await loginCallback(env, url, origin);
        case "POST /v1/login/finish":
          return await loginFinish(env, request);
        case "POST /v1/token":
          return await mint(env, request);
        case "GET /v1/whoami": {
          const { record } = await session(env, request);
          return json(record);
        }
        case "POST /v1/logout": {
          const { key, record } = await session(env, request);
          await revokeSession(env, key, record.login);
          console.log(JSON.stringify({ event: "session_revoked", login: record.login, device: record.device }));
          return json({ ok: true });
        }
        case "GET /v1/sessions": {
          const { record } = await session(env, request);
          return json({ sessions: await listSessions(env, record.login) });
        }
        case "POST /v1/sessions/revoke-all": {
          const { record } = await session(env, request);
          const revoked = await revokeAllSessions(env, record.login);
          console.log(JSON.stringify({ event: "sessions_revoked_all", login: record.login, count: revoked }));
          return json({ revoked });
        }
        case "GET /v1/audit":
          return await auditList(env, request, url);
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(JSON.stringify({ event: "error", route, message: String(error) }));
      return json({ error: "internal error" }, 500);
    }
  },
};
