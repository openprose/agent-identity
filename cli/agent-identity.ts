#!/usr/bin/env bun
// agent-identity: get short-lived GitHub tokens for agents from your broker.
//
//   agent-identity login --broker URL [--device NAME]   one-time browser login per machine
//   agent-identity token [--repo R]... [--write] [--fresh]  print a 1-hour installation token
//   agent-identity env [--repo R]... [--write]          print exports for gh and git identity
//   agent-identity git-credential get                   git credential helper (your org only)
//   agent-identity trailers                             commit trailers naming the human and session
//   agent-identity doctor                               check the broker, versions and wiring
//   agent-identity config                               print org, app and broker
//   agent-identity whoami | sessions | revoke-all | logout | audit [--sha HEX]
//
// Tokens are read-only unless you pass --write (the deployment's ceiling) or
// --perm name=read|write. Without --repo, the current checkout's origin is used
// when it belongs to your org.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const NAME = "agent-identity";
const CLI_VERSION = "0.2.1";
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), NAME);
const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), NAME);
const SESSION_FILE = join(CONFIG_DIR, "session.json");
const BOT_FILE = join(CONFIG_DIR, "bot.json");
const REUSE_MARGIN_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
// Environment variables that name the current agent session, first match wins.
// The label is recorded with every token the broker mints.
const DEFAULT_LABEL_VARS = ["CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID"];

type Session = {
  session_token: string;
  login: string;
  user_id: number;
  device: string;
  expires_at: string;
  broker: string;
  org: string;
  app: string;
};
type Minted = { token: string; expires_at: string; permissions: Record<string, string>; repositories: string[]; label: string };

function die(message: string, code = 1): never {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(code);
}

function privateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivate(path: string, value: unknown): void {
  privateDir(join(path, ".."));
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readJsonFile<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  } catch {
    return undefined; // corrupt file: treat as absent
  }
}

const readSession = () => readJsonFile<Session>(SESSION_FILE);

function requireSession(): Session {
  return readSession() ?? die(`not logged in; run \`${NAME} login --broker URL\``);
}

function checkBroker(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    die(`not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:") die(`broker must be https: ${url}`);
  return parsed.origin;
}

// The session token is only ever sent to the broker that issued it.
async function call(path: string, init: RequestInit & { auth?: boolean; broker?: string } = {}): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  let base = init.broker;
  if (init.auth !== false) {
    const session = requireSession();
    headers.authorization = `Bearer ${session.session_token}`;
    base = session.broker;
  }
  base ??= readSession()?.broker;
  if (!base) die(`no broker configured; run \`${NAME} login --broker URL\``);
  const response = await fetch(`${checkBroker(base)}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) die(`${(body as { error?: string }).error ?? `broker returned ${response.status}`}`);
  return body;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultLabel(): string {
  if (process.env.AGENT_IDENTITY_LABEL) return process.env.AGENT_IDENTITY_LABEL;
  const vars = process.env.AGENT_IDENTITY_LABEL_VARS?.split(/\s+/).filter(Boolean) ?? DEFAULT_LABEL_VARS;
  for (const name of vars) {
    const value = process.env[name];
    if (value && /^[A-Za-z0-9._:@/-]{1,100}$/.test(value)) return `${name.toLowerCase()}:${value}`;
  }
  return `manual@${hostname().split(".")[0]}`;
}

function originRepo(org: string): string | undefined {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"], { stderr: "ignore" });
  const url = proc.stdout.toString().trim();
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  return match && match[1].toLowerCase() === org.toLowerCase() ? match[2] : undefined;
}

type Args = { repos: string[]; perms: Record<string, string>; label: string; flags: Set<string>; values: Record<string, string> };

function parseArgs(argv: string[]): Args {
  const args: Args = { repos: [], perms: {}, label: defaultLabel(), flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? die(`${arg} needs a value`);
    if (arg === "--repo") args.repos.push(next());
    else if (arg === "--perm") {
      const [name, level] = next().split("=");
      if (!name || !level) die("--perm takes name=read|write");
      args.perms[name] = level;
    } else if (arg === "--label") args.label = next();
    else if (["--device", "--sha", "--limit", "--broker"].includes(arg)) args.values[arg.slice(2)] = next();
    else if (arg.startsWith("--")) args.flags.add(arg.slice(2));
    else die(`unexpected argument: ${arg}`);
  }
  return args;
}

// Revoke every cached installation token at GitHub, then drop the cache.
async function revokeCachedTokens(): Promise<void> {
  if (!existsSync(CACHE_DIR)) return;
  for (const name of readdirSync(CACHE_DIR)) {
    const cached = readJsonFile<Minted>(join(CACHE_DIR, name));
    if (cached && Date.parse(cached.expires_at) > Date.now()) {
      await fetch("https://api.github.com/installation/token", {
        method: "DELETE",
        headers: { authorization: `Bearer ${cached.token}`, accept: "application/vnd.github+json", "user-agent": `${NAME}-cli` },
      }).catch(() => undefined);
    }
  }
  rmSync(CACHE_DIR, { recursive: true, force: true });
}

function pruneCache(): void {
  if (!existsSync(CACHE_DIR)) return;
  for (const name of readdirSync(CACHE_DIR)) {
    const cached = readJsonFile<Minted>(join(CACHE_DIR, name));
    if (!cached || Date.parse(cached.expires_at) < Date.now()) rmSync(join(CACHE_DIR, name), { force: true });
  }
}

// `fresh` skips the cache so long-running callers (gh run watch) get a full hour.
// `write` asks for the deployment's full ceiling; otherwise tokens are read-only.
async function mint(repos: string[], perms: Record<string, string>, label: string, fresh = false, write = false): Promise<Minted> {
  const session = requireSession();
  const prefix = new RegExp(`^${session.org}/`, "i");
  repos = repos.map((repo) => repo.replace(prefix, ""));
  if (repos.length === 0) {
    const inferred = originRepo(session.org);
    if (!inferred) die(`pass --repo NAME (no ${session.org} origin remote in this directory)`);
    repos = [inferred];
  }
  if (write && Object.keys(perms).length) die("use --write or --perm, not both");
  const request = {
    repositories: [...new Set(repos)].sort(),
    ...(Object.keys(perms).length ? { permissions: perms } : { access: write ? "write" : "read" }),
    label,
  };
  const cacheFile = join(CACHE_DIR, `${sha256(session.session_token + JSON.stringify(request)).slice(0, 32)}.json`);
  const cached = fresh ? undefined : readJsonFile<Minted>(cacheFile);
  if (cached && Date.parse(cached.expires_at) - Date.now() > REUSE_MARGIN_MS) return cached;
  pruneCache();
  const minted = (await call("/v1/token", { method: "POST", body: JSON.stringify(request) })) as Minted;
  writePrivate(cacheFile, minted);
  return minted;
}

async function botIdentity(): Promise<{ name: string; email: string }> {
  const saved = readJsonFile<{ name: string; email: string }>(BOT_FILE);
  if (saved) return saved;
  const name = `${requireSession().app}[bot]`;
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": `${NAME}-cli` },
  });
  if (!response.ok) die(`could not look up ${name} (GitHub ${response.status})`);
  const { id } = (await response.json()) as { id: number };
  const identity = { name, email: `${id}+${name}@users.noreply.github.com` };
  writePrivate(BOT_FILE, identity);
  return identity;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Browser login. GitHub sends the browser back to the broker, which redirects
// it to this loopback listener with a one-time code. Run it in the
// background if the shell has no terminal; it waits up to 10 minutes.
async function login(device: string | undefined, brokerFlag: string | undefined): Promise<void> {
  const configured = brokerFlag ?? process.env.AGENT_IDENTITY_BROKER ?? readSession()?.broker;
  if (!configured) die(`pass --broker https://<your broker> (or set AGENT_IDENTITY_BROKER)`);
  const base = checkBroker(configured);
  const health = await call("/health", { auth: false, broker: base });
  if (!health.configured || !health.org || !health.app) die("the broker has no GitHub App configured yet");
  const pollSecret = randomBytes(32).toString("base64url");
  let receive: (code: string) => void;
  const received = new Promise<string>((resolve) => (receive = resolve));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const code = url.searchParams.get("code");
      if (url.pathname !== "/callback" || !code) return new Response("not found", { status: 404 });
      receive(code);
      return new Response("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;margin:4rem'>Logged in. You can close this tab.", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  try {
    const started = await call("/v1/login/start", {
      method: "POST",
      auth: false,
      broker: base,
      body: JSON.stringify({ poll_hash: sha256(pollSecret), device: device ?? hostname().split(".")[0], redirect_port: server.port }),
    });
    process.stderr.write(`Finish the GitHub login in your browser. If it did not open, visit:\n  ${started.url}\n`);
    if (process.platform === "darwin") Bun.spawn(["open", started.url]);
    else if (process.platform === "linux") Bun.spawn(["xdg-open", started.url], { stderr: "ignore" });
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("login timed out")), LOGIN_TIMEOUT_MS));
    const code = await Promise.race([received, timeout]).catch((error) => die((error as Error).message));
    const session = await call("/v1/login/finish", {
      method: "POST",
      auth: false,
      broker: base,
      body: JSON.stringify({ login_id: started.login_id, poll_secret: pollSecret, code }),
    });
    writePrivate(SESSION_FILE, { ...session, broker: base, org: health.org, app: health.app });
    rmSync(BOT_FILE, { force: true });
    process.stderr.write(`Logged in as ${session.login} on ${session.device} until ${session.expires_at}.\n`);
  } finally {
    server.stop(true);
  }
}

async function gitCredential(operation: string | undefined): Promise<void> {
  if (operation !== "get") return; // store/erase: nothing to persist
  const input: Record<string, string> = {};
  for (const line of (await Bun.stdin.text()).split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) input[line.slice(0, index)] = line.slice(index + 1);
  }
  if (input.protocol !== "https" || input.host !== "github.com") return;
  const session = readSession();
  if (!session) {
    process.stderr.write(`${NAME}: not logged in; run \`${NAME} login --broker URL\`\n`);
    return;
  }
  const [owner, repo] = (input.path ?? "").replace(/\.git$/, "").split("/");
  if (!owner || owner.toLowerCase() !== session.org.toLowerCase() || !repo) {
    if (!input.path) process.stderr.write(`${NAME}: set credential.useHttpPath=true for github.com/${session.org}\n`);
    return; // fall through to the next helper
  }
  const minted = await mint([repo], { contents: "write" }, defaultLabel());
  // git 2.41+ drops the credential once it expires instead of retrying it.
  const expiry = Math.floor(Date.parse(minted.expires_at) / 1000);
  process.stdout.write(`username=x-access-token\npassword=${minted.token}\npassword_expiry_utc=${expiry}\n`);
}

async function doctor(): Promise<void> {
  let failed = false;
  const check = (ok: boolean, label: string, hint = "") => {
    const suffix = !ok && hint ? ` (${hint})` : "";
    process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}${suffix}\n`);
    if (!ok) failed = true;
  };
  const session = readSession();
  check(Boolean(session), "logged in", `run ${NAME} login --broker URL`);
  if (session) {
    const version = await fetch(`${checkBroker(session.broker)}/version`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    check(Boolean(version), `broker reachable at ${session.broker}`);
    if (version) {
      check(version.version === CLI_VERSION, `broker ${version.version} matches CLI ${CLI_VERSION}`, "merge the same template release into both");
      check(!version.error, "broker configuration valid", version.error);
      check(version.configured === true, "broker has its GitHub App secrets", "run scripts/create-app.ts");
    }
    check(Date.parse(session.expires_at) > Date.now() + 3 * 86_400_000, `session valid until ${session.expires_at}`, "log in again soon");
    if (process.env.AGENT_IDENTITY_AGENT) {
      const helper = Bun.spawnSync(["git", "config", "--get-urlmatch", "credential.helper", `https://github.com/${session.org}/x`]).stdout.toString();
      check(helper.includes(`${NAME} git-credential`), "git uses the broker for your org", "check GIT_CONFIG_COUNT and agent.gitconfig");
      const gh = Bun.spawnSync(["sh", "-c", "command -v gh"]).stdout.toString().trim();
      check(gh.includes("agent-identity/bin/gh"), `gh resolves to the shim (${gh || "none"})`, "the harness may reset PATH after shell startup");
    } else {
      process.stdout.write("note not an agent shell; run doctor inside one to check the shell wiring\n");
    }
  }
  const gitVersion = /(\d+)\.(\d+)/.exec(Bun.spawnSync(["git", "--version"]).stdout.toString());
  const major = gitVersion ? Number(gitVersion[1]) : 0;
  const minor = gitVersion ? Number(gitVersion[2]) : 0;
  check(major > 2 || (major === 2 && minor >= 36), `git ${major}.${minor} (2.36+ needed for hasconfig includes)`);
  if (major === 2 && minor >= 36 && minor < 41) {
    process.stdout.write(`warn git ${major}.${minor} ignores credential expiry; 2.41+ drops expired tokens itself\n`);
  }
  process.exit(failed ? 1 : 0);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "git-credential") return gitCredential(rest[0]);
  const args = parseArgs(rest);
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  switch (command) {
    case "login":
      return login(args.values.device, args.values.broker);
    case "config": {
      const session = requireSession();
      return print({ org: session.org, app: session.app, broker: session.broker, login: session.login });
    }
    case "token": {
      const minted = await mint(args.repos, args.perms, args.label, args.flags.has("fresh"), args.flags.has("write"));
      if (args.flags.has("json")) print(minted);
      else process.stdout.write(minted.token + "\n");
      return;
    }
    case "env": {
      const minted = await mint(args.repos, args.perms, args.label, false, args.flags.has("write"));
      const bot = await botIdentity();
      const lines = [
        `export GH_TOKEN=${shellQuote(minted.token)}`,
        `export GIT_AUTHOR_NAME=${shellQuote(bot.name)}`,
        `export GIT_AUTHOR_EMAIL=${shellQuote(bot.email)}`,
        `export GIT_COMMITTER_NAME=${shellQuote(bot.name)}`,
        `export GIT_COMMITTER_EMAIL=${shellQuote(bot.email)}`,
      ];
      process.stdout.write(lines.join("\n") + "\n");
      return;
    }
    case "bot":
      return print(await botIdentity());
    case "trailers": {
      // For commit messages: who asked, and from which agent session.
      const session = requireSession();
      process.stdout.write(
        `Co-authored-by: ${session.login} <${session.user_id}+${session.login}@users.noreply.github.com>\n` +
          `Agent-Session: ${args.label}\n`,
      );
      return;
    }
    case "doctor":
      return doctor();
    case "whoami":
      return print({ broker: requireSession().broker, ...(await call("/v1/whoami")) });
    case "sessions":
      return print(await call("/v1/sessions"));
    case "revoke-all": {
      // Revoke this machine's tokens even if the broker call fails.
      await revokeCachedTokens();
      const result = await call("/v1/sessions/revoke-all", { method: "POST" });
      rmSync(SESSION_FILE, { force: true });
      return print(result);
    }
    case "logout": {
      // Clear local state first: a broker error must not leave a session behind.
      const session = readSession();
      rmSync(SESSION_FILE, { force: true });
      await revokeCachedTokens();
      if (session) {
        const response = await fetch(`${checkBroker(session.broker)}/v1/logout`, {
          method: "POST",
          headers: { authorization: `Bearer ${session.session_token}` },
        }).catch(() => undefined);
        if (!response?.ok) process.stderr.write("Could not revoke the session at the broker; run `revoke-all` after logging in again.\n");
      }
      process.stderr.write("Logged out; cached tokens removed.\n");
      return;
    }
    case "audit": {
      const query = args.values.sha ? `token_sha256=${args.values.sha}` : `limit=${args.values.limit ?? "20"}`;
      return print(await call(`/v1/audit?${query}`));
    }
    default:
      process.stderr.write(readFileSync(import.meta.path, "utf8").split("\n").slice(1, 16).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
      process.exit(command ? 2 : 0);
  }
}

await main();
