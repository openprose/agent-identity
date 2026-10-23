// The git credential helper must never let an org URL fall through to the
// person's own helpers, whatever the letter case and whatever goes wrong.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

setDefaultTimeout(20_000);
const cli = join(import.meta.dir, "..", "cli", "agent-identity.ts");

function credential(home: string, path: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync([process.execPath, cli, "git-credential", "get"], {
    stdin: new TextEncoder().encode(`protocol=https\nhost=github.com\npath=${path}\n\n`),
    env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
  });
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

test("with no session, an org URL in any case answers quit=1; others fall through", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-cred-"));
  expect(credential(home, "MyOrg/x.git", { AGENT_IDENTITY_ORG: "myorg" })).toEqual({ code: 0, out: "quit=1\n" });
  expect(credential(home, "someone/x.git", { AGENT_IDENTITY_ORG: "myorg" })).toEqual({ code: 0, out: "" });
});

test("a broker failure for an org URL answers quit=1 instead of falling through", () => {
  const home = mkdtempSync(join(tmpdir(), "cli-cred-"));
  mkdirSync(join(home, ".config/agent-identity"), { recursive: true });
  writeFileSync(
    join(home, ".config/agent-identity/session.json"),
    JSON.stringify({
      session_token: "ais_" + "x".repeat(40),
      login: "someone",
      user_id: 1,
      device: "test",
      expires_at: "2099-01-01T00:00:00Z",
      broker: "https://127.0.0.1:9",
      org: "myorg",
      app: "myorg-agents",
    }),
  );
  expect(credential(home, "MYORG/x.git")).toEqual({ code: 0, out: "quit=1\n" });
});
