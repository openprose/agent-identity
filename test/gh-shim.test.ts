// The gh shim decides, per command, whether gh runs as the bot or as the
// person. Drive it with a fake gh (prints which token it got) and a fake
// agent-identity CLI (mints "bot-<repo>").
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shim = join(import.meta.dir, "..", "agent-env", "gh");
const root = mkdtempSync(join(tmpdir(), "gh-shim-"));
const shimDir = join(root, "shim");
const fakeDir = join(root, "fake");
const checkout = join(root, "checkout");

beforeAll(() => {
  mkdirSync(shimDir);
  mkdirSync(fakeDir);
  mkdirSync(checkout);
  // The shim finds the real gh as the next gh on PATH after its own directory.
  Bun.spawnSync(["ln", "-s", shim, join(shimDir, "gh")]);
  writeFileSync(join(fakeDir, "gh"), '#!/bin/bash\nprintf "token=%s args=%s\\n" "${GH_TOKEN:-personal}" "$*"\n');
  writeFileSync(
    join(fakeDir, "agent-identity"),
    `#!/bin/bash
repo=""; json=""; kind=bot
while [ $# -gt 0 ]; do case "$1" in --repo) repo=$2; shift ;; --json) json=1 ;; --write) kind=botw ;; esac; shift; done
[ "$FAKE_MINT" = fail ] && { echo "not logged in" >&2; exit 1; }
if [ "$kind" = botw ]; then perms="\${FAKE_PERMS:-{\\"contents\\":\\"write\\",\\"actions\\":\\"read\\"}}"
else perms='{"contents":"read","actions":"read"}'; fi
if [ -n "$json" ]; then printf '{"token":"%s-%s","permissions":%s}\\n' "$kind" "$repo" "$perms"
else printf '%s-%s\\n' "$kind" "$repo"; fi
`,
  );
  chmodSync(join(fakeDir, "gh"), 0o755);
  chmodSync(join(fakeDir, "agent-identity"), 0o755);
  Bun.spawnSync(["git", "init", "-q"], { cwd: checkout });
  Bun.spawnSync(["git", "remote", "add", "origin", "git@github.com:MyOrg/widgets.git"], { cwd: checkout });
});

function gh(args: string[], env: Record<string, string> = {}, cwd = root) {
  const proc = Bun.spawnSync([join(shimDir, "gh"), ...args], {
    cwd,
    env: {
      HOME: root,
      PATH: `${shimDir}:${fakeDir}:/usr/bin:/bin:/opt/homebrew/bin`,
      AGENT_IDENTITY_AGENT: "1",
      AGENT_IDENTITY_ORG: "myorg",
      ...env,
    },
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

describe("routing", () => {
  test.each([
    [["pr", "list", "-R", "myorg/api"], "bot-api"],
    [["pr", "list", "--repo=MyOrg/api"], "bot-api"],
    [["issue", "view", "https://github.com/myorg/api/issues/3"], "bot-api"],
    [["api", "repos/myorg/api/pulls"], "bot-api"],
    [["api", "-X", "GET", "/repos/myorg/api"], "bot-api"],
    [["repo", "view", "myorg/docs"], "bot-docs"],
  ])("%j runs as the bot", (args, token) => {
    expect(gh(args).out).toStartWith(`token=${token} `);
  });

  test.each([
    [["pr", "list", "-R", "someone/else"]],
    [["api", "user"]],
    [["api", "repos/other/api"]],
    [["auth", "status"]],
    [["search", "repos", "myorg"]],
    [["repo", "view", "someone/else"]],
  ])("%j stays personal", (args) => {
    expect(gh(args).out).toStartWith("token=personal ");
  });

  test("AGENT_IDENTITY_REAL_GH lets a wrapper hand off when PATH does not include the shim", () => {
    const proc = Bun.spawnSync([join(shimDir, "gh"), "pr", "list", "-R", "myorg/api"], {
      cwd: root,
      env: {
        HOME: root,
        PATH: `${fakeDir}:/usr/bin:/bin`,
        AGENT_IDENTITY_AGENT: "1",
        AGENT_IDENTITY_ORG: "myorg",
        AGENT_IDENTITY_REAL_GH: join(fakeDir, "gh"),
      },
    });
    expect(proc.stdout.toString()).toStartWith("token=bot-api ");
  });

  test("with read fallback, ruleset reads use the personal login; writes never do", () => {
    const env = { AGENT_IDENTITY_FALLBACK: "personal" };
    expect(gh(["api", "repos/myorg/api/rulesets/1"], env).out).toStartWith("token=personal ");
    // Without fallback the bot is used, and refused here: this token lacks administration.
    expect(gh(["api", "repos/myorg/api/rulesets/1"]).code).toBe(1);
    // A ruleset write needs administration write, which the bot never has:
    // refused, and never sent through the personal login.
    const write = gh(["api", "-X", "PUT", "repos/myorg/api/rulesets/1"], env);
    expect(write.code).toBe(1);
    expect(write.out).toBe("");
  });

  test("environment secret listings need the Environments permission", () => {
    expect(gh(["secret", "list", "--env", "production", "-R", "myorg/api"]).code).toBe(1);
    expect(gh(["secret", "list", "--env", "production", "-R", "myorg/api"], { AGENT_IDENTITY_FALLBACK: "personal" }).out).toStartWith("token=personal ");
  });

  test("AGENT_IDENTITY_PROBE answers gh version only", () => {
    expect(gh(["version"], { AGENT_IDENTITY_PROBE: "1" }).out).toStartWith("agent-identity shim reached");
    expect(gh(["pr", "list", "-R", "myorg/api"], { AGENT_IDENTITY_PROBE: "1" }).out).toStartWith("token=bot-api ");
  });

  test("AGENT_IDENTITY_PERSONAL=deny wins over read fallback", () => {
    const env = { AGENT_IDENTITY_FALLBACK: "personal", AGENT_IDENTITY_PERSONAL: "deny" };
    expect(gh(["api", "repos/myorg/api/rulesets/1"], env).code).toBe(1);
    expect(gh(["secret", "list", "-R", "myorg/api"], env).code).toBe(1);
  });

  test("outside agent shells the shim is inert", () => {
    expect(gh(["pr", "list", "-R", "myorg/api"], { AGENT_IDENTITY_AGENT: "" }).out).toStartWith("token=personal ");
  });

  test("reads get a read-only token and writes ask for --write", () => {
    expect(gh(["pr", "view", "1", "-R", "myorg/api"]).out).toStartWith("token=bot-api ");
    expect(gh(["pr", "merge", "1", "-R", "myorg/api"]).out).toStartWith("token=botw-api ");
    expect(gh(["api", "-X", "POST", "repos/myorg/api/issues"]).out).toStartWith("token=botw-api ");
    expect(gh(["api", "repos/myorg/api/issues"]).out).toStartWith("token=bot-api ");
  });

  test("an inherited GH_TOKEN never stands in for the bot on org repositories", () => {
    expect(gh(["pr", "list", "-R", "myorg/api"], { GH_TOKEN: "inherited" }).out).toStartWith("token=bot-api ");
    expect(gh(["pr", "list", "-R", "someone/else"], { GH_TOKEN: "inherited" }).out).toStartWith("token=inherited ");
    expect(gh(["pr", "list", "-R", "myorg/api"], { GITHUB_TOKEN: "inherited" }).out).toStartWith("token=bot-api ");
  });

  test("the shim's own token and AGENT_IDENTITY_RESPECT_GH_TOKEN pass straight through", () => {
    expect(gh(["pr", "list", "-R", "myorg/api"], { GH_TOKEN: "botw-api", AGENT_IDENTITY_SHIM_TOKEN: "1" }).out).toStartWith("token=botw-api ");
    expect(gh(["pr", "list", "-R", "myorg/api"], { GH_TOKEN: "mine", AGENT_IDENTITY_RESPECT_GH_TOKEN: "1" }).out).toStartWith("token=mine ");
  });

  test("the checkout's origin decides when nothing names a repository", () => {
    expect(gh(["pr", "list"], {}, checkout).out).toStartWith("token=bot-widgets ");
    expect(gh(["api", "graphql", "-f", "query={viewer{login}}"], {}, checkout).out).toStartWith("token=bot-widgets ");
  });

  test("gh auth token returns the bot token inside an org checkout only", () => {
    expect(gh(["auth", "token"], {}, checkout).out).toBe("botw-widgets");
    expect(gh(["auth", "token"]).out).toStartWith("token=personal ");
  });
});

describe("refusals", () => {
  test("a failed mint never falls back to the personal login", () => {
    const result = gh(["pr", "list", "-R", "myorg/api"], { FAKE_MINT: "fail" });
    expect(result.code).toBe(1);
    expect(result.out).toBe("");
  });

  test("a command needing a permission the bot lacks is refused by default", () => {
    const result = gh(["workflow", "run", "ci.yml", "-R", "myorg/api"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("lacks actions:write");
    expect(result.out).toBe("");
  });

  test("AGENT_IDENTITY_FALLBACK=personal lets only reads use the personal login", () => {
    const read = gh(["secret", "list", "-R", "myorg/api"], { AGENT_IDENTITY_FALLBACK: "personal" });
    expect(read.out).toBe("token=personal args=secret list -R myorg/api");
    expect(gh(["secret", "list", "-R", "myorg/api"]).code).toBe(1);
    const write = gh(["workflow", "run", "ci.yml", "-R", "myorg/api"], { AGENT_IDENTITY_FALLBACK: "personal" });
    expect(write.code).toBe(1);
    expect(write.out).toBe("");
  });

  test.each([
    [["api", "-X", "PUT", "orgs/myorg/actions/permissions"], "org-level writes"],
    [["api", "-XPATCH", "https://api.github.com/orgs/MyOrg"], "org-level writes"],
    [["api", "repositories/123/issues", "-f", "title=x"], "numeric-id"],
    [["api", "graphql", "-f", "query=mutation { deleteRepository }"], "GraphQL mutations"],
  ])("%j is refused outright", (args, message) => {
    const result = gh(args, { AGENT_IDENTITY_FALLBACK: "personal" });
    expect(result.code).toBe(1);
    expect(result.err).toContain(message);
    expect(result.out).toBe("");
  });

  test("AGENT_IDENTITY_PERSONAL=read keeps personal reads and refuses personal writes", () => {
    const env = { AGENT_IDENTITY_PERSONAL: "read" };
    expect(gh(["pr", "list", "-R", "someone/else"], env).out).toStartWith("token=personal ");
    expect(gh(["api", "user"], env).out).toStartWith("token=personal ");
    expect(gh(["api", "graphql", "-f", "query={viewer{login}}"], env).out).toStartWith("token=personal ");
    for (const args of [
      ["pr", "create", "-R", "someone/else"],
      ["auth", "token"],
      ["api", "-X", "POST", "teams/1/discussions"],
      ["api", "graphql", "-F", "query=@q.graphql"],
      ["api", "-X", "GET", "graphql", "-f", "query=mutation { x }"],
      ["project", "create", "--owner", "myorg"],
    ]) {
      const result = gh(args, env);
      expect(result.code, args.join(" ")).toBe(1);
      expect(result.out).toBe("");
    }
    // Org repositories still use the bot.
    expect(gh(["pr", "create", "-R", "myorg/api"], env).out).toStartWith("token=botw-api ");
  });

  test("AGENT_IDENTITY_PERSONAL=deny refuses every personal-login command", () => {
    const result = gh(["api", "user"], { AGENT_IDENTITY_PERSONAL: "deny" });
    expect(result.code).toBe(1);
    expect(gh(["pr", "list", "-R", "myorg/api"], { AGENT_IDENTITY_PERSONAL: "deny" }).out).toStartWith("token=bot-api ");
  });

  test("reads of org and numeric-id endpoints still pass through", () => {
    expect(gh(["api", "orgs/myorg"]).out).toStartWith("token=personal ");
    expect(gh(["variable", "list", "-R", "myorg/api"]).out).toStartWith("token=personal ");
  });

  test("with the permission granted, the bot runs it", () => {
    const perms = JSON.stringify({ contents: "write", actions: "write" });
    expect(gh(["workflow", "run", "ci.yml", "-R", "myorg/api"], { FAKE_PERMS: perms }).out).toStartWith("token=botw-api ");
  });

  test("two shim copies on PATH stop instead of looping", () => {
    const second = join(root, "shim2");
    mkdirSync(second, { recursive: true });
    Bun.spawnSync(["ln", "-sf", shim, join(second, "gh")]);
    const proc = Bun.spawnSync([join(shimDir, "gh"), "pr", "list", "-R", "myorg/api"], {
      env: { HOME: root, PATH: `${shimDir}:${second}:${shimDir}:${fakeDir}:/usr/bin:/bin`, AGENT_IDENTITY_AGENT: "1", AGENT_IDENTITY_ORG: "myorg" },
      timeout: 4000,
    });
    expect(proc.exitCode).toBe(127);
    expect(proc.stderr.toString()).toContain("nested too deep");
  });

  test("secret and variable writes are refused", () => {
    expect(gh(["secret", "set", "X", "-R", "myorg/api"]).code).toBe(1);
    expect(gh(["variable", "set", "X", "-R", "myorg/api"]).code).toBe(1);
  });
});
