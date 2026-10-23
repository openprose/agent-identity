// End-to-end tests for the token broker Worker: a fake Env (in-memory KV,
// rate limits, a fresh App key) and a stubbed `fetch` that plays GitHub.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { DEFAULT_MAX_PERMISSIONS } from "../worker/src/lib";

const ORG = "myorg";
const TEAM = "agents";
const CLIENT_ID = "Iv1.testclientid";
const CLIENT_SECRET = "test-client-secret";
const ORIGIN = "https://broker.example.test";
const INSTALLATION_ID = 4242;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_PRIVATE_KEY = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const APP_PUBLIC_KEY: KeyObject = publicKey;

// ---- Fake Cloudflare bindings ----

type KvEntry = { value: string; expiresAt?: number };

class FakeKV {
  readonly data = new Map<string, KvEntry>();
  failPut: (key: string) => boolean = () => false;

  async get(key: string, type?: "text" | "json"): Promise<unknown> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return type === "json" ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (this.failPut(key)) throw new Error(`KV put failed for ${key}`);
    this.data.set(key, {
      value,
      expiresAt: options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(options: { prefix?: string; limit?: number } = {}): Promise<{ keys: { name: string }[] }> {
    const names = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
    return { keys: names.slice(0, options.limit ?? 1000).map((name) => ({ name })) };
  }

  keys(prefix: string): string[] {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix));
  }
}

class FakeRateLimit {
  calls: string[] = [];
  allow = true;
  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    this.calls.push(key);
    return { success: this.allow };
  }
}

function makeEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    STATE: new FakeKV(),
    MINT_LIMIT: new FakeRateLimit(),
    LOGIN_LIMIT: new FakeRateLimit(),
    GITHUB_ORG: ORG,
    GITHUB_TEAM: TEAM,
    APP_ID: "123456",
    APP_CLIENT_ID: CLIENT_ID,
    APP_SLUG: "agent-identity-test",
    APP_CLIENT_SECRET: CLIENT_SECRET,
    APP_PRIVATE_KEY,
    ...overrides,
  };
}

type Env = ReturnType<typeof makeEnv>;

// ---- Fake GitHub ----

type Recorded = { method: string; url: string; authorization: string; body: unknown };

class FakeGitHub {
  requests: Recorded[] = [];
  granted: Record<string, string> = {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: "read",
    checks: "read",
    statuses: "read",
    metadata: "read",
    members: "read",
  };
  teamExists = true;
  members = new Map<string, string>(); // login -> membership state
  users = new Map<string, { login: string; id: number }>(); // OAuth code -> user
  userTokens = new Map<string, { login: string; id: number }>(); // user token -> user
  minted: { token: string; body: { repositories?: string[]; permissions: Record<string, string> } }[] = [];
  revokedInstallationTokens: string[] = [];
  revokedUserTokens: string[] = [];
  private counter = 0;

  addUser(login: string, id: number, member = true): string {
    const code = `gh-code-${login}-${++this.counter}`;
    this.users.set(code, { login, id });
    if (member) this.members.set(login.toLowerCase(), "active");
    return code;
  }

  accessTokenRequests() {
    return this.requests.filter((r) => r.method === "POST" && r.url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`));
  }

  private appJwtValid(authorization: string): boolean {
    const match = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(authorization);
    if (!match) return false;
    const ok = verify(
      "sha256",
      Buffer.from(`${match[1]}.${match[2]}`),
      APP_PUBLIC_KEY,
      Buffer.from(match[3], "base64url"),
    );
    const payload = JSON.parse(Buffer.from(match[2], "base64url").toString()) as { iss: string; exp: number };
    return ok && payload.iss === CLIENT_ID && payload.exp > Date.now() / 1000;
  }

  private installationTokenValid(authorization: string): boolean {
    const token = authorization.replace(/^Bearer /, "");
    return this.minted.some((m) => m.token === token) && !this.revokedInstallationTokens.includes(token);
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const authorization = headers.get("authorization") ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, url: url.href, authorization, body });
    const reply = (status: number, payload?: unknown) =>
      new Response(payload === undefined ? null : JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (url.origin === "https://github.com" && method === "POST" && url.pathname === "/login/oauth/access_token") {
      const user = this.users.get(body?.code);
      if (!user || body.client_id !== CLIENT_ID || body.client_secret !== CLIENT_SECRET) {
        return reply(200, { error: "bad_verification_code" });
      }
      const token = `ghu_${user.login}_${++this.counter}`;
      this.userTokens.set(token, user);
      return reply(200, { access_token: token, token_type: "bearer" });
    }
    if (url.origin !== "https://api.github.com") return reply(599, { message: `unexpected host ${url.origin}` });

    const path = url.pathname;
    if (method === "GET" && path === `/orgs/${ORG}/installation`) {
      return this.appJwtValid(authorization) ? reply(200, { id: INSTALLATION_ID }) : reply(401, { message: "bad jwt" });
    }
    if (method === "GET" && path === `/app/installations/${INSTALLATION_ID}`) {
      if (!this.appJwtValid(authorization)) return reply(401, { message: "bad jwt" });
      return reply(200, { id: INSTALLATION_ID, permissions: { ...this.granted } });
    }
    if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
      if (!this.appJwtValid(authorization)) return reply(401, { message: "bad jwt" });
      const permissions = body.permissions as Record<string, string>;
      for (const [name, level] of Object.entries(permissions)) {
        const have = this.granted[name];
        if (!have || (level === "write" && have !== "write")) {
          return reply(422, { message: `The permissions requested are not granted to this installation: ${name}` });
        }
      }
      const token = `ghs_${"x".repeat(20)}${++this.counter}`;
      this.minted.push({ token, body });
      return reply(201, {
        token,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { ...permissions },
        ...(body.repositories ? { repositories: body.repositories.map((name: string) => ({ name })) } : {}),
      });
    }
    const membership = new RegExp(`^/orgs/${ORG}/teams/${TEAM}/memberships/([^/]+)$`).exec(path);
    if (method === "GET" && membership) {
      if (!this.installationTokenValid(authorization)) return reply(401, { message: "bad token" });
      const state = this.teamExists ? this.members.get(decodeURIComponent(membership[1]).toLowerCase()) : undefined;
      return state ? reply(200, { state, role: "member" }) : reply(404, { message: "Not Found" });
    }
    if (method === "GET" && path === `/orgs/${ORG}/teams/${TEAM}`) {
      if (!this.installationTokenValid(authorization)) return reply(401, { message: "bad token" });
      return this.teamExists ? reply(200, { slug: TEAM }) : reply(404, { message: "Not Found" });
    }
    if (method === "DELETE" && path === "/installation/token") {
      this.revokedInstallationTokens.push(authorization.replace(/^Bearer /, ""));
      return reply(204);
    }
    if (method === "GET" && path === "/user") {
      const user = this.userTokens.get(authorization.replace(/^Bearer /, ""));
      return user ? reply(200, user) : reply(401, { message: "Bad credentials" });
    }
    if (method === "DELETE" && path === `/applications/${CLIENT_ID}/token`) {
      if (authorization !== `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`) return reply(401, { message: "bad basic" });
      this.revokedUserTokens.push(body.access_token);
      this.userTokens.delete(body.access_token);
      return reply(204);
    }
    return reply(404, { message: `fake GitHub has no route for ${method} ${path}` });
  };
}

// ---- Harness ----

type Worker = { fetch(request: Request, env: Env): Promise<Response> };

const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
let gh: FakeGitHub;
let worker: Worker;
let moduleCounter = 0;

beforeEach(async () => {
  gh = new FakeGitHub();
  globalThis.fetch = gh.fetch as typeof fetch;
  console.log = () => undefined;
  console.error = () => undefined;
  // A fresh module instance per test, so per-isolate caches (installation id,
  // members token, granted permissions) never leak between tests.
  worker = (await import(`../worker/src/index.ts?test=${++moduleCounter}`)).default as Worker;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
});

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const sha256B64 = (value: string) => createHash("sha256").update(value).digest("base64");
const sha256B64url = (value: string) => createHash("sha256").update(value).digest("base64url");

function call(env: Env, method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": "192.0.2.1" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  return worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    env,
  );
}

async function startLogin(env: Env, port = 49152) {
  const pollSecret = `poll-${crypto.randomUUID()}`;
  const response = await call(env, "POST", "/v1/login/start", {
    body: { poll_hash: sha256Hex(pollSecret), redirect_port: port, device: "laptop-1" },
  });
  expect(response.status).toBe(200);
  const started = (await response.json()) as { login_id: string; url: string; expires_in: number };
  return { pollSecret, ...started, authorize: new URL(started.url) };
}

async function callback(env: Env, loginId: string, code: string) {
  return call(env, "GET", `/v1/login/callback?state=${encodeURIComponent(loginId)}&code=${encodeURIComponent(code)}`);
}

// Full happy-path login; returns the session token.
async function login(env: Env, loginName = "alice", id = 1001): Promise<string> {
  const ghCode = gh.addUser(loginName, id);
  const started = await startLogin(env);
  const redirected = await callback(env, started.login_id, ghCode);
  expect(redirected.status).toBe(303);
  const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
  const finished = await call(env, "POST", "/v1/login/finish", {
    body: { login_id: started.login_id, poll_secret: started.pollSecret, code },
  });
  expect(finished.status).toBe(200);
  return ((await finished.json()) as { session_token: string }).session_token;
}

// ---- Tests ----

describe("health and version", () => {
  test("health reports configuration", async () => {
    const env = makeEnv();
    expect(await (await call(env, "GET", "/health")).json()).toEqual({
      ok: true,
      configured: true,
      app: "agent-identity-test",
      org: ORG,
    });
    const bare = makeEnv({ APP_PRIVATE_KEY: undefined });
    expect(((await (await call(bare, "GET", "/health")).json()) as { configured: boolean }).configured).toBe(false);
    expect((await call(bare, "POST", "/v1/login/start", { body: {} })).status).toBe(503);
  });

  test("version reports the effective defaults", async () => {
    const body = (await (await call(makeEnv(), "GET", "/version")).json()) as Record<string, unknown>;
    expect(body.max_permissions).toEqual(DEFAULT_MAX_PERMISSIONS);
    expect(body.default_access).toBe("read");
    expect(body.error).toBeUndefined();
  });
});

describe("login", () => {
  test("full login with PKCE, loopback redirect, user-token revocation, single-use finish", async () => {
    const env = makeEnv();
    const ghCode = gh.addUser("alice", 1001);
    const started = await startLogin(env, 50123);

    // Authorize URL carries the PKCE challenge.
    expect(started.authorize.origin + started.authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(started.authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(started.authorize.searchParams.get("state")).toBe(started.login_id);
    expect(started.authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/v1/login/callback`);
    expect(started.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = started.authorize.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.LOGIN_LIMIT.calls).toEqual(["192.0.2.1"]);

    // Callback: exchange (with verifier), read user, revoke user token, redirect to loopback.
    const redirected = await callback(env, started.login_id, ghCode);
    expect(redirected.status).toBe(303);
    const location = new URL(redirected.headers.get("location")!);
    expect(location.origin).toBe("http://127.0.0.1:50123");
    expect(location.pathname).toBe("/callback");
    const code = location.searchParams.get("code")!;
    expect(code.length).toBeGreaterThanOrEqual(20);

    const exchange = gh.requests.find((r) => r.url === "https://github.com/login/oauth/access_token")!;
    const exchangeBody = exchange.body as Record<string, string>;
    expect(exchangeBody.code).toBe(ghCode);
    expect(exchangeBody.redirect_uri).toBe(`${ORIGIN}/v1/login/callback`);
    expect(typeof exchangeBody.code_verifier).toBe("string");
    expect(sha256B64url(exchangeBody.code_verifier)).toBe(challenge!);

    const revoke = gh.requests.find((r) => r.method === "DELETE" && r.url.endsWith(`/applications/${CLIENT_ID}/token`));
    expect(revoke).toBeDefined();
    expect(gh.revokedUserTokens).toHaveLength(1);
    expect(gh.userTokens.size).toBe(0);
    // Membership was checked live, with the members token.
    expect(gh.requests.some((r) => r.url.endsWith(`/teams/${TEAM}/memberships/alice`))).toBe(true);

    // Callback replay is refused.
    expect((await callback(env, started.login_id, ghCode)).status).toBe(400);

    // Wrong poll secret is refused and does not consume the login.
    const wrongSecret = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: "not-the-secret", code },
    });
    expect(wrongSecret.status).toBe(404);

    // Wrong code counts an attempt but the login survives.
    const wrongCode = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: started.pollSecret, code: "nope" },
    });
    expect(wrongCode.status).toBe(403);

    const finished = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: started.pollSecret, code },
    });
    expect(finished.status).toBe(200);
    const session = (await finished.json()) as Record<string, unknown>;
    expect(session.session_token).toMatch(/^ais_[A-Za-z0-9_-]{43}$/);
    expect(session).toMatchObject({ login: "alice", user_id: 1001, device: "laptop-1" });
    expect(env.STATE.keys("session:")).toHaveLength(1);
    expect(env.STATE.keys("user-session:alice:")).toHaveLength(1);
    expect(env.STATE.keys("login:")).toHaveLength(0);

    // Finish replay fails.
    const replay = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: started.pollSecret, code },
    });
    expect(replay.status).toBe(404);

    // The session works.
    const whoami = await call(env, "GET", "/v1/whoami", { token: session.session_token as string });
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({ login: "alice", user_id: 1001 });
  });

  test("login/start validates its input", async () => {
    const env = makeEnv();
    const bad = [
      { poll_hash: "abc", redirect_port: 50000 },
      { poll_hash: sha256Hex("x"), redirect_port: 80 },
      { poll_hash: sha256Hex("x"), redirect_port: 70000 },
      { poll_hash: sha256Hex("x"), redirect_port: "50000" },
    ];
    for (const body of bad) expect((await call(env, "POST", "/v1/login/start", { body })).status).toBe(400);
    env.LOGIN_LIMIT.allow = false;
    expect((await call(env, "POST", "/v1/login/start", { body: bad[0] })).status).toBe(429);
  });

  test("five wrong codes burn the login", async () => {
    const env = makeEnv();
    const ghCode = gh.addUser("alice", 1001);
    const started = await startLogin(env);
    const redirected = await callback(env, started.login_id, ghCode);
    const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;
    for (let i = 0; i < 5; i++) {
      const wrong = await call(env, "POST", "/v1/login/finish", {
        body: { login_id: started.login_id, poll_secret: started.pollSecret, code: `wrong-${i}` },
      });
      expect(wrong.status).toBe(403);
    }
    const late = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: started.pollSecret, code },
    });
    expect(late.status).toBe(404);
    expect(env.STATE.keys("session:")).toHaveLength(0);
  });

  test("a non-member is denied and gets no session", async () => {
    const env = makeEnv();
    const ghCode = gh.addUser("mallory", 666, false);
    const started = await startLogin(env);
    const denied = await callback(env, started.login_id, ghCode);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("location")).toBeNull();
    expect(await denied.text()).toContain("mallory is not a member of myorg/agents");
    // The user token is still revoked.
    expect(gh.revokedUserTokens).toHaveLength(1);

    const finished = await call(env, "POST", "/v1/login/finish", {
      body: { login_id: started.login_id, poll_secret: started.pollSecret, code: "anything" },
    });
    expect(finished.status).toBe(403);
    expect(((await finished.json()) as { error: string }).error).toContain("not a member");
    expect(env.STATE.keys("session:")).toHaveLength(0);
    expect(env.STATE.keys("user-session:")).toHaveLength(0);
    expect(env.STATE.keys("member:")).toHaveLength(0);
    expect(env.STATE.keys("login:")).toHaveLength(0);
  });

  test("a missing team yields 503 and keeps existing sessions", async () => {
    const env = makeEnv();
    const token = await login(env, "alice", 1001);
    gh.teamExists = false;
    // Let the membership cache lapse.
    for (const key of env.STATE.keys("member:")) await env.STATE.delete(key);

    const whoami = await call(env, "GET", "/v1/whoami", { token });
    expect(whoami.status).toBe(503);
    expect(((await whoami.json()) as { error: string }).error).toContain("not found");
    expect(env.STATE.keys("session:")).toHaveLength(1);
    expect(env.STATE.keys("user-session:alice:")).toHaveLength(1);

    const minted = await call(env, "POST", "/v1/token", { token, body: { repositories: ["api"] } });
    expect(minted.status).toBe(503);
    expect(env.STATE.keys("session:")).toHaveLength(1);

    // A new login also fails with 503 rather than a silent denial.
    const ghCode = gh.addUser("bob", 1002);
    const started = await startLogin(env);
    expect((await callback(env, started.login_id, ghCode)).status).toBe(503);

    // Once the team is back, the old session works again.
    gh.teamExists = true;
    expect((await call(env, "GET", "/v1/whoami", { token })).status).toBe(200);
  });
});

describe("minting", () => {
  async function mintRequestBody(env: Env, token: string, body: unknown) {
    const before = gh.accessTokenRequests().length;
    const response = await call(env, "POST", "/v1/token", { token, body });
    const sent = gh.accessTokenRequests().slice(before).map((r) => r.body as { repositories?: string[]; permissions: Record<string, string> });
    return { response, sent: sent.filter((b) => !("members" in b.permissions)) };
  }

  test("requires a session and repositories", async () => {
    const env = makeEnv();
    expect((await call(env, "POST", "/v1/token", { body: { repositories: ["api"] } })).status).toBe(401);
    expect((await call(env, "POST", "/v1/token", { token: "ais_" + "A".repeat(43), body: { repositories: ["api"] } })).status).toBe(401);
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("repositories is required");
    expect(sent).toHaveLength(0);
    expect((await call(env, "POST", "/v1/token", { token, body: { repositories: ["myorg/api"] } })).status).toBe(400);
  });

  test("the default request is read-only", async () => {
    const env = makeEnv();
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["docs", "api"], label: "ci:job-1" });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].repositories).toEqual(["api", "docs"]);
    expect(Object.keys(sent[0].permissions).sort()).toEqual(Object.keys(DEFAULT_MAX_PERMISSIONS).sort());
    for (const level of Object.values(sent[0].permissions)) expect(level).toBe("read");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ login: "alice", label: "ci:job-1", repositories: ["api", "docs"] });
    expect(body.token).toBe(gh.minted.at(-1)!.token);
    expect(env.MINT_LIMIT.calls).toEqual(["user:1001"]);
  });

  test('access: "write" sends the ceiling', async () => {
    const env = makeEnv();
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"], access: "write" });
    expect(response.status).toBe(200);
    expect(sent[0].permissions).toEqual(DEFAULT_MAX_PERMISSIONS);
  });

  test("permissions are capped at what the installation grants", async () => {
    const env = makeEnv();
    gh.granted = { contents: "write", pull_requests: "read", actions: "read", checks: "read", metadata: "read", members: "read" };
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"], access: "write" });
    expect(response.status).toBe(200);
    // pull_requests lowered to read; issues and statuses dropped.
    expect(sent[0].permissions).toEqual({
      contents: "write",
      pull_requests: "read",
      actions: "read",
      checks: "read",
      metadata: "read",
    });

    // Explicit permissions are capped the same way.
    const explicit = await mintRequestBody(env, token, {
      repositories: ["api"],
      permissions: { pull_requests: "write", issues: "write" },
    });
    expect(explicit.response.status).toBe(200);
    expect(explicit.sent[0].permissions).toEqual({ metadata: "read", pull_requests: "read" });
  });

  test("a MAX_PERMISSIONS that grants write on workflows or repository_hooks fails and /version reports it", async () => {
    for (const name of ["workflows", "repository_hooks"]) {
      const env = makeEnv({ MAX_PERMISSIONS: JSON.stringify({ contents: "write", [name]: "write" }) });
      const token = await login(env);
      const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"], access: "write" });
      expect(response.status).toBe(500);
      expect(((await response.json()) as { error: string }).error).toBeTruthy();
      expect(sent).toHaveLength(0);
      const version = (await (await call(env, "GET", "/version")).json()) as Record<string, unknown>;
      expect(version.error).toBe(`MAX_PERMISSIONS: ${name} may not be write`);
      expect(version.max_permissions).toBeUndefined();
    }
  });

  test("a MAX_PERMISSIONS that grants read on workflows is honoured", async () => {
    const env = makeEnv({ MAX_PERMISSIONS: JSON.stringify({ contents: "write", workflows: "read" }) });
    gh.granted.workflows = "write";
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"], access: "write" });
    expect(response.status).toBe(200);
    expect(sent[0].permissions).toEqual({ metadata: "read", contents: "write", workflows: "read" });
  });

  test('DEFAULT_ACCESS="ceiling" restores the ceiling default', async () => {
    const env = makeEnv({ DEFAULT_ACCESS: "ceiling" });
    const token = await login(env);
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"] });
    expect(response.status).toBe(200);
    expect(sent[0].permissions).toEqual(DEFAULT_MAX_PERMISSIONS);
    // access: "read" still narrows.
    const narrowed = await mintRequestBody(env, token, { repositories: ["api"], access: "read" });
    for (const level of Object.values(narrowed.sent[0].permissions)) expect(level).toBe("read");
    const version = (await (await call(env, "GET", "/version")).json()) as Record<string, unknown>;
    expect(version.default_access).toBe("ceiling");

    const broken = makeEnv({ DEFAULT_ACCESS: "everything" });
    expect(((await (await call(broken, "GET", "/version")).json()) as { error: string }).error).toBe(
      "DEFAULT_ACCESS must be read or ceiling",
    );
  });

  test("rate limit is per user", async () => {
    const env = makeEnv();
    const token = await login(env);
    env.MINT_LIMIT.allow = false;
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"] });
    expect(response.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  test("audit is fail-closed: a failed audit write revokes the token and withholds it", async () => {
    const env = makeEnv();
    const token = await login(env);
    env.STATE.failPut = (key) => key.startsWith("audit");
    const { response, sent } = await mintRequestBody(env, token, { repositories: ["api"] });
    expect(sent).toHaveLength(1);
    expect(response.status).toBe(503);
    const text = await response.text();
    const mintedToken = gh.minted.at(-1)!.token;
    expect(text).not.toContain(mintedToken);
    expect(text).toContain("revoked");
    expect(gh.revokedInstallationTokens).toContain(mintedToken);
    const revoke = gh.requests.find((r) => r.method === "DELETE" && r.url.endsWith("/installation/token"));
    expect(revoke?.authorization).toBe(`Bearer ${mintedToken}`);
  });

  test("audit entries identify the person, label and token hash", async () => {
    const env = makeEnv();
    const token = await login(env);
    const response = await call(env, "POST", "/v1/token", { token, body: { repositories: ["api"], label: "agent:task-7" } });
    expect(response.status).toBe(200);
    const minted = ((await response.json()) as { token: string }).token;

    expect(env.STATE.keys("audit:")).toHaveLength(1);
    const shaKey = `audit-sha:${sha256Hex(minted)}`;
    const stored = (await env.STATE.get(shaKey, "json")) as Record<string, unknown>;
    expect(stored).toMatchObject({
      event: "token_minted",
      login: "alice",
      device: "laptop-1",
      label: "agent:task-7",
      repositories: ["api"],
      token_sha256: sha256Hex(minted),
      token_sha256_b64: sha256B64(minted),
    });
    expect(stored.token_sha256_b64).toBe(Buffer.from(sha256Hex(minted), "hex").toString("base64"));
    expect(JSON.stringify(stored)).not.toContain(minted);

    const lookup = (await (await call(env, "GET", `/v1/audit?token_sha256=${sha256Hex(minted)}`, { token })).json()) as {
      entries: unknown[];
    };
    expect(lookup.entries).toEqual([stored]);
    const listed = (await (await call(env, "GET", "/v1/audit", { token })).json()) as { entries: unknown[] };
    expect(listed.entries).toEqual([stored]);
    expect((await call(env, "GET", "/v1/audit")).status).toBe(401);
  });

  test("the members token requests only members:read and is used for team checks", async () => {
    const env = makeEnv();
    const token = await login(env);
    await call(env, "POST", "/v1/token", { token, body: { repositories: ["api"], access: "write" } });
    const membersRequests = gh.accessTokenRequests().filter((r) => "members" in (r.body as { permissions: object }).permissions);
    expect(membersRequests).toHaveLength(1);
    expect(membersRequests[0].body).toEqual({ permissions: { members: "read" } });
    // No other mint ever carries members.
    const others = gh.accessTokenRequests().filter((r) => !membersRequests.includes(r));
    expect(others.length).toBeGreaterThan(0);
    for (const r of others) {
      const body = r.body as { repositories?: string[]; permissions: Record<string, string> };
      expect(body.permissions.members).toBeUndefined();
      expect(body.repositories).toEqual(["api"]);
    }
    const membersToken = gh.minted.find((m) => "members" in m.body.permissions)!.token;
    const teamCalls = gh.requests.filter((r) => r.url.includes(`/teams/${TEAM}`));
    expect(teamCalls.length).toBeGreaterThan(0);
    for (const r of teamCalls) expect(r.authorization).toBe(`Bearer ${membersToken}`);
  });

  test("a members token carrying extra permissions is revoked and refused", async () => {
    const env = makeEnv();
    const ghCode = gh.addUser("alice", 1001);
    const originalFetch = gh.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      if (String(input).endsWith("/access_tokens") && response.status === 201) {
        const body = (await response.json()) as { permissions: Record<string, string> };
        body.permissions = { ...body.permissions, contents: "write" };
        return new Response(JSON.stringify(body), { status: 201 });
      }
      return response;
    }) as typeof fetch;
    const started = await startLogin(env);
    const response = await callback(env, started.login_id, ghCode);
    expect(response.status).toBe(503);
    expect(gh.revokedInstallationTokens).toEqual([gh.minted[0].token]);
  });
});

describe("sessions", () => {
  test("removal from the team revokes every session of that person", async () => {
    const env = makeEnv();
    const first = await login(env, "alice", 1001);
    const second = await login(env, "alice", 1001);
    const other = await login(env, "bob", 1002);
    expect(env.STATE.keys("user-session:alice:")).toHaveLength(2);

    gh.members.delete("alice");
    // While the 5-minute membership cache holds, alice still passes.
    expect((await call(env, "GET", "/v1/whoami", { token: first })).status).toBe(200);
    await env.STATE.delete("member:alice");

    const minted = await call(env, "POST", "/v1/token", { token: first, body: { repositories: ["api"] } });
    expect(minted.status).toBe(403);
    expect(((await minted.json()) as { error: string }).error).toContain("no longer in myorg/agents");
    expect(env.STATE.keys("user-session:alice:")).toHaveLength(0);
    expect((await call(env, "GET", "/v1/whoami", { token: second })).status).toBe(401);
    // Bob is untouched.
    expect((await call(env, "GET", "/v1/whoami", { token: other })).status).toBe(200);
    expect(env.STATE.keys("session:")).toHaveLength(1);
  });

  test("logout deletes only the current session", async () => {
    const env = makeEnv();
    const first = await login(env);
    const second = await login(env);
    const listed = (await (await call(env, "GET", "/v1/sessions", { token: first })).json()) as { sessions: unknown[] };
    expect(listed.sessions).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toContain(first);

    const out = await call(env, "POST", "/v1/logout", { token: first });
    expect(out.status).toBe(200);
    expect((await call(env, "GET", "/v1/whoami", { token: first })).status).toBe(401);
    expect((await call(env, "GET", "/v1/whoami", { token: second })).status).toBe(200);
    expect(env.STATE.keys("user-session:alice:")).toHaveLength(1);
    expect(env.STATE.keys(`session:${sha256Hex(first)}`)).toHaveLength(0);
  });

  test("revoke-all deletes every session of the caller", async () => {
    const env = makeEnv();
    const first = await login(env);
    const second = await login(env);
    const other = await login(env, "bob", 1002);
    const response = await call(env, "POST", "/v1/sessions/revoke-all", { token: second });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: 2 });
    expect((await call(env, "GET", "/v1/whoami", { token: first })).status).toBe(401);
    expect((await call(env, "GET", "/v1/whoami", { token: second })).status).toBe(401);
    expect((await call(env, "GET", "/v1/whoami", { token: other })).status).toBe(200);
  });

  test("malformed bearer tokens are refused before any lookup", async () => {
    const env = makeEnv();
    for (const token of ["", "short", "AIS_" + "a".repeat(30), "ais_" + "a".repeat(10)]) {
      expect((await call(env, "GET", "/v1/whoami", { token })).status).toBe(401);
    }
    expect(gh.requests).toHaveLength(0);
  });
});
