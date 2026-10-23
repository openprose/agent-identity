// scripts/upstream-diff.sh tells an instance whether it differs from the
// template only by instance configuration.
import { expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "..", "scripts", "upstream-diff.sh");
const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...identity, GIT_CONFIG_COUNT: "0" } });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
}

function diff(cwd: string) {
  const proc = Bun.spawnSync([join(cwd, "scripts", "upstream-diff.sh")], { cwd, env: { ...process.env, GIT_CONFIG_COUNT: "0" } });
  return { code: proc.exitCode, out: proc.stdout.toString() };
}

test("an instance passes with config only, and fails once code drifts", () => {
  const root = mkdtempSync(join(tmpdir(), "upstream-diff-"));
  const template = join(root, "template");
  mkdirSync(join(template, "scripts"), { recursive: true });
  cpSync(script, join(template, "scripts", "upstream-diff.sh"));
  writeFileSync(join(template, "README.md"), "template\n");
  git(template, "init", "-q", "-b", "main");
  git(template, "add", "-A");
  git(template, "commit", "-qm", "template");

  const instance = join(root, "instance");
  git(root, "clone", "-q", template, instance);
  git(instance, "remote", "rename", "origin", "upstream");
  mkdirSync(join(instance, "worker"));
  writeFileSync(join(instance, "worker", "wrangler.toml"), 'name = "broker"\n');
  writeFileSync(join(instance, "INSTANCE.md"), "ours\n");
  git(instance, "add", "-A");
  git(instance, "commit", "-qm", "instance config");
  expect(diff(instance)).toMatchObject({ code: 0 });

  appendFileSync(join(instance, "README.md"), "local edit\n");
  git(instance, "commit", "-qam", "drift");
  const drifted = diff(instance);
  expect(drifted.code).toBe(1);
  expect(drifted.out).toContain("README.md");

  appendFileSync(join(template, "README.md"), "upstream change\n");
  git(template, "commit", "-qam", "upstream");
  expect(diff(instance).out).toContain("template commits not yet merged: 1");
});
