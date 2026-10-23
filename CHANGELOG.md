# Changelog

Merge tagged releases into your instance (see UPGRADING.md). Entries marked
**re-approve** change `app-manifest.json`, so every installer must approve the
App's new permissions; entries marked **config** need a `worker/wrangler.toml`
change.

## 0.2.8

Fixes from the re-verification of 0.2.7.

- Combined short flags (`-ifkey=v`, `-iX DELETE`) are parsed the way `gh`
  parses them: they count as writes, and the endpoint scan skips their values.
- For your org's repositories in any letter case, the git credential helper
  answers `quit=1` when it cannot mint (no session, broker unreachable), so git
  never falls through to personal credentials.
- The last `-R` wins, as in `gh`; positional org references on another host are
  refused; `gh variable get` counts as a read.
- Spawn-heavy tests get longer timeouts.

## 0.2.7

Fixes from an adversarial pre-publication review.

- **Breaking:** `AGENT_IDENTITY_PERSONAL` defaults to `read`: agent shells may
  only read with your personal login. Set `allow` in `env.sh` to keep the old
  behaviour.
- **Breaking:** an allowlist replaces the never-write list. Only `contents`,
  `pull_requests`, `issues`, `actions`, `checks`, `statuses`, `deployments`,
  `pages` and `discussions` can be write; a `MAX_PERMISSIONS` asking write on
  anything else fails every mint.
- The `gh` shim resolves every spelling of an org repository (`-R=`, any letter
  case, `www.`/`api.` hosts, `git@`/`ssh://` forms, `{owner}`/`{repo}`
  placeholders, `GH_REPO`, any remote) and refuses org references it cannot
  resolve, instead of using the personal login.
- Attached-value flags (`-fkey=v`, `--field=k=v`, `--input=file`) count as
  writes; GraphQL bodies read from files count as possible mutations.
- git: the broker answers first for every github.com credential (your other
  helpers stay behind it); `www.` and more SSH spellings of org remotes are
  rewritten; the git include is appended after existing `GIT_CONFIG_*` entries.
- Login uses PKCE. Mint rate limits are per person. A missing team is a
  configuration error, not a removal. The internal members token is checked to
  carry nothing else, and an empty permission set is never sent to GitHub.
- The broker re-resolves the installation id after a reinstall.
- `install.sh --uninstall`; Codex shells (`CODEX_THREAD_ID`) detected by
  default; Git LFS paths; unknown CLI options are errors; `create-app.ts`
  checks `worker/wrangler.toml` first and explains recovery; the manifest no
  longer names a webhook URL.
- Tests for the broker (login, minting, audit, sessions) and the installer.

## 0.2.6

- `AGENT_IDENTITY_PERSONAL=deny` now also overrides `AGENT_IDENTITY_FALLBACK=personal`.
- The doctor probe answers only `gh version`, so a stray `AGENT_IDENTITY_PROBE` cannot turn other commands into silent successes.

## 0.2.5

- `gh secret list --env <name>` needs the Environments permission (GitHub gates environment secrets on it), so the bot is refused unless granted, or the read uses the personal login with `AGENT_IDENTITY_FALLBACK=personal`.

## 0.2.4

- Test fix only: the 0.2.3 ruleset test expected the wrong result for a ruleset write (it is refused, correctly). Same behaviour as 0.2.3.

## 0.2.3

- With `AGENT_IDENTITY_FALLBACK=personal`, `gh api` reads of rulesets use the
  personal login: GitHub returns ruleset bypass actors only to repository
  admins, never to an App, so checks that verify bypass lists need it.

## 0.2.2

- `doctor` checks that `gh` actually reaches the shim (directly or through a
  wrapper's `AGENT_IDENTITY_REAL_GH` handoff), not just where `gh` resolves.

## 0.2.1

- `AGENT_IDENTITY_REAL_GH` names the real `gh` for the shim, so a `gh`
  wrapper that stays on `PATH` can hand off to the shim in harnesses that
  reset `PATH` after shell startup (see "Limits and residual risk").

## 0.2.0

First tagged release of the template.

**Breaking:** `workflows` write can no longer be granted. If your
`MAX_PERMISSIONS` includes `"workflows":"write"`, every mint fails until you
remove it (`agent-identity doctor` or `GET /version` shows the error).
**Breaking:** requests that name no permissions now get read-only tokens; set
`DEFAULT_ACCESS = "ceiling"` until every machine runs CLI 0.2.0.

- Tokens are **read-only unless writes are asked for** (`token --write`, or
  `--perm name=write`). The `gh` shim asks for writes only for commands that
  write. **config:** set `DEFAULT_ACCESS = "ceiling"` to keep the old
  behaviour for CLIs older than this release while you upgrade them.
- `workflows`, `administration`, `members`, secrets, environments and Actions
  variables can never be write; a `MAX_PERMISSIONS` naming one is refused and
  reported by `GET /version`.
- **Fail-closed audit:** a token whose audit record cannot be written is
  revoked at GitHub and never returned. Audit records also carry
  `token_sha256_b64`, matching GitHub's `hashed_token`.
- The git credential helper reports `password_expiry_utc`.
- `agent-identity trailers` prints `Co-authored-by:` (the human) and
  `Agent-Session:` (the session label) for commit messages.
- `agent-identity doctor` checks the broker, versions, configuration and shell
  wiring; the Worker serves `GET /version`.
- `logout` and `revoke-all` revoke cached installation tokens at GitHub.
- An inherited `GH_TOKEN`/`GITHUB_TOKEN` no longer stands in for the bot on
  your org's repositories.
- The App's permissions live in the committed `app-manifest.json`.
- `scripts/upstream-diff.sh [ref]` compares against the release you merged.
