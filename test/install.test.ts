// install.sh writes the agent git config. Run it against a temporary HOME with
// a fake CLI, then ask git which credential helpers and URL rewrites apply.
import { expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests spawn shells and git; give them room on a loaded machine.
setDefaultTimeout(20_000);

const install = join(import.meta.dir, "..", "agent-env", "install.sh");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "install-"));
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "agent-identity"),
    `#!/bin/bash
case "$1" in
  config) echo '{"org":"myorg"}' ;;
  bot) echo '{"name":"myorg-agents[bot]","email":"1+myorg-agents[bot]@users.noreply.github.com"}' ;;
  git-credential)
    echo broker >> "$HELPER_LOG"
    [ "$2" = get ] || exit 0
    path=$(sed -n 's/^path=//p')
    owner=$(printf %s "\${path%%/*}" | tr '[:upper:]' '[:lower:]')
    [ "$owner" = myorg ] && printf 'username=x-access-token\npassword=bot-token\n'
    ;;
esac
`,
  );
  chmodSync(join(fakeBin, "agent-identity"), 0o755);
  writeFileSync(
    join(fakeBin, "personal-helper"),
    `#!/bin/bash
echo personal >> "$HELPER_LOG"
[ "$1" = get ] && printf 'username=someone\npassword=personal-token\n'
`,
  );
  chmodSync(join(fakeBin, "personal-helper"), 0o755);
  // The person's usual git setup: a reset, then their own helper for github.com.
  writeFileSync(join(home, ".gitconfig"), '[credential "https://github.com"]\n\thelper =\n\thelper = !personal-helper\n');
  writeFileSync(join(home, ".zshrc"), "# existing\n");
  const env = {
    HOME: home,
    PATH: `${fakeBin}:${join(home, ".local/bin")}:/usr/bin:/bin:/opt/homebrew/bin`,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return { home, env };
}

// Ask git for a credential the way a push would, with logging fake helpers:
// returns which password git got and which helpers it asked, in order.
function fill(env: Record<string, string>, home: string, path: string) {
  const log = join(home, "helpers.log");
  writeFileSync(log, "");
  const proc = Bun.spawnSync(["git", "credential", "fill"], {
    stdin: new TextEncoder().encode(`protocol=https\nhost=github.com\npath=${path}\n\n`),
    env: {
      ...env,
      HELPER_LOG: log,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "include.path",
      GIT_CONFIG_VALUE_0: join(home, ".config/agent-identity/agent.gitconfig"),
    },
  });
  const password = /password=(.*)/.exec(proc.stdout.toString())?.[1] ?? "";
  return { password, asked: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

test("the broker answers for the org in any case; other owners fall through to the usual helper", () => {
  const { home, env } = setup();
  const result = Bun.spawnSync([install], { env });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(fill(env, home, "myorg/x.git")).toEqual({ password: "bot-token", asked: ["broker"] });
  expect(fill(env, home, "MyOrg/x.git")).toEqual({ password: "bot-token", asked: ["broker"] });
  expect(fill(env, home, "someone/x.git")).toEqual({ password: "personal-token", asked: ["broker", "personal"] });
});

test("www. and SSH spellings of org remotes are rewritten to https://github.com", () => {
  const { home, env } = setup();
  Bun.spawnSync([install], { env });
  const repo = join(home, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repo,
      env: { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "include.path", GIT_CONFIG_VALUE_0: join(home, ".config/agent-identity/agent.gitconfig") },
    }).stdout.toString().trim();
  git("init", "-q");
  for (const [url, expected] of [
    ["https://www.github.com/myorg/x.git", "https://github.com/myorg/x.git"],
    ["git@github.com:myorg/x.git", "https://github.com/myorg/x.git"],
    ["ssh://git@github.com:22/myorg/x.git", "https://github.com/myorg/x.git"],
    ["github.com:myorg/x.git", "https://github.com/myorg/x.git"],
  ]) {
    git("remote", "remove", "origin");
    git("remote", "add", "origin", url);
    expect(git("ls-remote", "--get-url", "origin"), url).toBe(expected);
  }
  expect(git("config", "user.name")).toBe("myorg-agents[bot]");
});

test("--uninstall removes the shell lines and generated files", () => {
  const { home, env } = setup();
  Bun.spawnSync([install], { env });
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toContain("agent-identity/agent-env.sh");
  const result = Bun.spawnSync([install, "--uninstall"], { env });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("# existing\n");
  expect(Bun.file(join(home, ".config/agent-identity/agent.gitconfig")).size).toBe(0);
});
