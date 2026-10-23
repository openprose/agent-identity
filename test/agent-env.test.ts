// agent-env.sh decides which shells act as the bot. Run it under bash and zsh
// with a clean environment and check what it exports.
import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// These tests spawn shells and git; give them room on a loaded machine.
setDefaultTimeout(20_000);

const script = join(import.meta.dir, "..", "agent-env", "agent-env.sh");
const home = mkdtempSync(join(tmpdir(), "agent-env-"));
const shells = ["bash", "zsh"].filter((shell) => Bun.spawnSync(["which", shell]).exitCode === 0);

function run(shell: string, env: Record<string, string>) {
  const proc = Bun.spawnSync(
    [shell, "-c", `. "${script}"; printf '%s|%s|%s' "\${AGENT_IDENTITY_AGENT:-no}" "\${PATH%%:*}" "\${GIT_CONFIG_COUNT:-0}"`],
    { env: { HOME: home, PATH: "/usr/bin:/bin", ...env } },
  );
  const [agent, firstPath, gitConfig] = proc.stdout.toString().split("|");
  return { agent, firstPath, gitConfig };
}

describe.each(shells)("agent-env.sh under %s", (shell) => {
  const bin = join(home, ".local/share/agent-identity/bin");

  test("a marked agent shell gets the shim first and the git include", () => {
    expect(run(shell, { CLAUDECODE: "1" })).toEqual({ agent: "1", firstPath: bin, gitConfig: "1" });
  });

  test("a custom detection variable works", () => {
    expect(run(shell, { ORCH_SESSION: "s1", AGENT_IDENTITY_DETECT: "ORCH_SESSION OTHER" }).agent).toBe("1");
  });

  test("a human shell is untouched", () => {
    expect(run(shell, { TERM: "xterm" })).toEqual({ agent: "no", firstPath: "/usr/bin", gitConfig: "0" });
  });

  test("AGENT_IDENTITY_DISABLE opts a shell out", () => {
    expect(run(shell, { CLAUDECODE: "1", AGENT_IDENTITY_DISABLE: "1" }).agent).toBe("no");
  });

  test("the git include is appended after existing GIT_CONFIG entries, once", () => {
    const proc = Bun.spawnSync(
      [shell, "-c", `. "${script}"; . "${script}"; printf '%s|%s|%s|%s' "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_KEY_1" "\${GIT_CONFIG_VALUE_1##*/}"`],
      { env: { HOME: home, PATH: "/usr/bin:/bin", CLAUDECODE: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.harness", GIT_CONFIG_VALUE_0: "x" } },
    );
    expect(proc.stdout.toString()).toBe("2|core.harness|include.path|agent.gitconfig");
  });

  test("a detection list with shell syntax falls back to the defaults, never evaluated", () => {
    const marker = join(home, "pwned");
    const result = run(shell, { AGENT_IDENTITY_DETECT: `X;touch ${marker}`, CLAUDECODE: "1" });
    expect(result.agent).toBe("1");
    expect(Bun.file(marker).size).toBe(0);
  });
});
