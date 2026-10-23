# Upgrading an instance

GitHub's **Use this template** button copies the template once. It does not
keep your copy in sync. This page explains how an instance (your team's copy)
keeps taking improvements from the template.

## The rule: values in the instance, code in the template

Your instance should differ from the template only in instance-only files:

| File | What it holds |
| --- | --- |
| `worker/wrangler.toml` | Your org and team, the App's non-secret ids, the Worker name, the KV namespace id, your Cloudflare account id, and optionally `MAX_PERMISSIONS`. No secrets. |
| `INSTANCE.md` (optional) | Notes for your team: where the broker runs, who holds deploy rights, local conventions. |

The template never contains these files, so a merge never conflicts on them.

Everything else (Worker code, CLI, `agent-env/`, scripts, tests) should match
the template exactly. If you need a code change, make it in the template (or
in your own copy of the template) and let it flow down through a merge. Do
not patch code in the instance: local edits turn every later upgrade into a
conflict, and they are easy to lose.

## Setting up the `upstream` remote

### Recommended: clone, then push to a new private repository

```sh
git clone <template URL> <your-instance> && cd <your-instance>
git remote rename origin upstream
git remote add origin <URL of a new, empty, PRIVATE repository in <your-org>>
git push -u origin main
```

History is shared with the template, so every later upgrade is an ordinary
merge.

Do **not** use GitHub's **Fork** button. A fork of a public repository is
public, and your instance's `wrangler.toml` and `INSTANCE.md` describe your
deployment.

### If you already used the "Use this template" button

The button creates a repository with unrelated history. Join the histories
once, keeping your instance-only files and taking everything else from the
template at a release tag:

```sh
git remote add upstream <template URL>
git fetch upstream --tags
git merge --allow-unrelated-histories -s ours --no-commit <tag>
git restore --source=<tag> --staged --worktree -- . ':!worker/wrangler.toml' ':!INSTANCE.md'
git commit -m "Join template history at <tag>"
```

`-s ours` records the merge without changing any file; the `git restore` then
replaces every file except the instance-only ones with the template's version
at `<tag>`. Any code you had changed locally is overwritten, which is the
point: move those changes into the template first if you want to keep them.
If the template added files after you copied it, `git restore` brings them in;
if it removed files, delete them yourself (`git diff --stat <tag>` shows what
is left).

After this one-time merge, later upgrades are ordinary merges.

## Upgrading

1. **Pick a release, not `main`.** Tagged releases are the supported upgrade
   points. Merge a tag:
   ```sh
   git fetch upstream --tags
   git merge <tag>
   ```
   Merging `upstream/main` works, but you get whatever is in flight.
2. **Read the release notes first** (the CHANGELOG or the release on GitHub,
   for every version between yours and the new one). Look for migration
   notes, in particular:
   - **App permission changes.** If a release changes the permissions the App
     requests, you must update the App's permissions in its GitHub settings,
     and every installation then has to approve the new permissions before
     tokens can carry them. Until it is approved, the broker caps tokens at
     what the installation was granted. The committed `app-manifest.json`
     shows the permissions the template intends; compare it with your App's
     settings page.
   - **New Worker settings or bindings** that need values in your
     `worker/wrangler.toml`. Compare it with `worker/wrangler.example.toml`.
   - **Changes to `agent-env/`** that need a reinstall on each machine.
3. **Check for drift.** `scripts/upstream-diff.sh <tag>` compares your
   instance with the release you merged (with no argument, `upstream/main`),
   lists template commits you have not merged, and fails if any file other
   than the instance-only ones differs. After the merge it must report that only
   instance configuration differs. If it lists other files, either finish the
   merge or move those changes upstream.
4. **Run the checks.**
   ```sh
   bun install
   bun test
   bun run typecheck
   agent-identity doctor
   ```
5. **Redeploy the broker** from a machine and login that hold deploy rights
   (not from an agent shell): `bun run deploy`.
6. **Reinstall the agent-shell integration** on each machine if anything under
   `agent-env/` changed: `agent-env/install.sh`. It is idempotent and keeps
   your existing `env.sh`. Open a new agent shell and check `command -v gh`.

If something breaks, roll back with `git revert -m 1 <merge commit>` and
redeploy. Sessions and the audit log live in KV and are not affected by a
code rollback.

## Breaking changes by release

- **0.2.7:** `AGENT_IDENTITY_PERSONAL` now defaults to `read`; add
  `export AGENT_IDENTITY_PERSONAL=allow` to `env.sh` if agents must write with
  people's own logins elsewhere. `MAX_PERMISSIONS` may ask write only on
  `contents`, `pull_requests`, `issues`, `actions`, `checks`, `statuses`,
  `deployments`, `pages` and `discussions`. Re-run `agent-env/install.sh` on
  each machine so the new git credential order applies.

- **0.2.0:** remove `"workflows":"write"` from `MAX_PERMISSIONS` if present
  (it is now refused, and every mint fails until you do). Requests that name
  no permissions get read-only tokens; set `DEFAULT_ACCESS = "ceiling"` in
  `worker/wrangler.toml` until every machine has the 0.2.0 CLI and shim, then
  remove it.

## Optional: an update workflow

You can automate step 1 with a scheduled job in your instance that notices a
new template tag, merges it on a branch, runs the tests, and **opens a pull
request**. Keep it to that:

- It may only open a pull request. It never pushes to your default branch and
  never deploys. A person reads the release notes, reviews the diff, merges,
  and deploys.
- Give it only the permissions it needs to push a branch and open a pull
  request. It should not hold Cloudflare credentials.
- Treat the template as code you are about to run with your App's key: the
  pull request review is where you decide to trust a new release.
