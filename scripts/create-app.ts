#!/usr/bin/env bun
// One-time: register your agents' GitHub App from a manifest and hand its
// secrets straight to your broker Worker.
//
//   bun scripts/create-app.ts --org <org> --broker https://<your broker> [--name <app name>] [--actions-write]
//
// The private key and client secret pass through this process's memory and
// into `wrangler secret put` on stdin. They are never written to disk or
// printed. An owner of <org> clicks "Create GitHub App" in the browser.
// Deploy the Worker once first (so --broker exists), from worker/wrangler.toml.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

const ORG = flag("org");
const BROKER_FLAG = flag("broker");
const APP_NAME = flag("name") ?? `${ORG}-agents`;
const PORT = Number(flag("port") ?? "47811");
if (!ORG || !/^[A-Za-z0-9-]+$/.test(ORG) || !BROKER_FLAG) {
  console.error("usage: bun scripts/create-app.ts --org <org> --broker https://<your broker> [--name <app name>] [--actions-write]");
  process.exit(2);
}
const brokerUrl = new URL(BROKER_FLAG);
if (brokerUrl.protocol !== "https:") throw new Error("--broker must be https");
const BROKER = brokerUrl.origin;
const WORKER_DIR = join(import.meta.dir, "..", "worker");
const state = randomBytes(16).toString("hex");

// What the installation may grant. Minted tokens are narrowed further by the
// broker's MAX_PERMISSIONS. `members: read` lets the broker check team
// membership; it is never handed to agents.
const manifest = {
  name: APP_NAME,
  url: `https://github.com/${ORG}`,
  description: `Identity for ${ORG}'s AI agents. One-hour tokens are minted per agent session by the team's own broker.`,
  public: false,
  redirect_url: `http://127.0.0.1:${PORT}/callback`,
  callback_urls: [`${BROKER}/v1/login/callback`],
  hook_attributes: { url: `${BROKER}/webhook`, active: false },
  request_oauth_on_install: false,
  default_events: [],
  default_permissions: {
    contents: "write",
    pull_requests: "write",
    issues: "write",
    actions: process.argv.includes("--actions-write") ? "write" : "read",
    checks: "read",
    statuses: "read",
    metadata: "read",
    members: "read",
  },
};

async function wrangler(args: string[], stdin?: string): Promise<void> {
  const proc = Bun.spawn(["wrangler", ...args], {
    cwd: WORKER_DIR,
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined) {
    proc.stdin!.write(stdin);
    proc.stdin!.end();
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed with exit code ${code}`);
}

function setVar(toml: string, name: string, value: string): string {
  const line = `${name} = ${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${name} = .*$`, "m");
  return pattern.test(toml) ? toml.replace(pattern, line) : toml.replace(/^\[vars\]$/m, `[vars]\n${line}`);
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const html = (body: string) =>
  new Response(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;max-width:40rem;margin:4rem auto">${body}`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

let done: (summary: string) => void;
const finished = new Promise<string>((resolve) => (done = resolve));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return html(`<p>Sending the ${escape(APP_NAME)} manifest to GitHub…</p>
<form id="f" method="post" action="https://github.com/organizations/${ORG}/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
<button>Continue to GitHub</button></form><script>document.getElementById("f").submit()</script>`);
    }
    if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
    if (url.searchParams.get("state") !== state) return new Response("state mismatch", { status: 400 });

    const code = url.searchParams.get("code") ?? "";
    const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "user-agent": "agent-identity-setup" },
    });
    if (!response.ok) {
      done(`manifest conversion failed: GitHub ${response.status}`);
      return html(`<p>GitHub refused the conversion (${response.status}). Check the terminal.</p>`);
    }
    const app = (await response.json()) as { id: number; slug: string; client_id: string; client_secret: string; pem: string };

    try {
      await wrangler(["secret", "put", "APP_PRIVATE_KEY"], app.pem);
      await wrangler(["secret", "put", "APP_CLIENT_SECRET"], app.client_secret);
      const tomlPath = join(WORKER_DIR, "wrangler.toml");
      let toml = readFileSync(tomlPath, "utf8");
      toml = setVar(toml, "APP_SLUG", app.slug);
      toml = setVar(toml, "APP_CLIENT_ID", app.client_id);
      toml = setVar(toml, "APP_ID", String(app.id));
      writeFileSync(tomlPath, toml);
      await wrangler(["deploy"]);
    } catch (error) {
      done(`app ${app.slug} (id ${app.id}) was created but broker setup failed: ${(error as Error).message}`);
      return html(`<p>The app was created but configuring the broker failed. Check the terminal.</p>`);
    }

    const install = `https://github.com/apps/${app.slug}/installations/new`;
    done(`created ${app.slug} (app id ${app.id}); broker configured and deployed.\ninstall: ${install}`);
    return html(`<h1>Created ${escape(app.slug)}</h1><p>The broker has its key. Last step: install the app on <b>${escape(ORG)}</b>.</p>
<p><a href="${escape(install)}">Install ${escape(app.slug)} on ${escape(ORG)}</a></p>`);
  },
});

console.log(`Open http://127.0.0.1:${PORT}/ in a browser signed in to GitHub as an owner of ${ORG}.`);
if (process.platform === "darwin") Bun.spawn(["open", `http://127.0.0.1:${PORT}/`]);
console.log(await finished);
setTimeout(() => server.stop(true), 500);
