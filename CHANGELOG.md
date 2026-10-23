# Changelog

Merge tagged releases into your instance (see UPGRADING.md). Entries marked
**re-approve** change `app-manifest.json`, so every installer must approve the
App's new permissions; entries marked **config** need a `worker/wrangler.toml`
change.

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
