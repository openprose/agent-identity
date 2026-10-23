# agent-identity

Give your team's AI agents their own GitHub identity and short-lived credentials,
instead of letting them act as you.

This is a **template**, not a product or a service. Each team creates its own
GitHub App and deploys its own small token broker on its own Cloudflare account.
There is no hosted endpoint, no shared service, and no telemetry. The point is
to have *fewer* trusted parties, not one more.

```
agent shell ──session──▶ your broker (Cloudflare Worker) ──App JWT──▶ GitHub
  gh / git                holds the App's private key        returns a 1-hour token
  (shim + git config)     checks your GitHub team            narrowed to named repos
                          logs every token by sha256         and capped permissions
```

What you get:

- **A separate identity.** Agent commits, pushes, PRs, comments and workflow
  runs show up as `<your-app>[bot]`, not as a person.
- **Short-lived, narrow tokens.** Every token lasts one hour, names the
  repositories it is for (at most 20), and carries no more than a capped set of
  permissions. Agents never hold a long-lived GitHub credential.
- **The key never touches a laptop.** The App's private key goes from GitHub's
  manifest flow straight into a Worker secret. Nobody downloads a `.pem`.
- **Team-gated human login.** A person logs in once per machine through
  GitHub in the browser. Only members of one GitHub team can get a session,
  and removing someone from the team cuts them off on their next request.
- **Transparent per-shell routing.** In shells your agents run, `git` and `gh`
  use the bot automatically for your org's repositories. Your own terminal,
  and other orgs' repositories, keep your personal login.
- **Per-session provenance.** Each token is recorded with the person, device,
  IP and agent session that asked for it, keyed by the token's sha256, so any
  action on GitHub can be traced back to the session that took it.

## How it works

| Piece | Where | What it does |
| --- | --- | --- |
| GitHub App | your org | The bot identity. Private, so it can only be installed on your org. |
| Broker | `worker/` | Holds the App key. Logs people in, checks team membership, mints narrowed one-hour installation tokens, keeps an audit trail. |
| CLI | `cli/agent-identity.ts` | `login`, `token`, `env`, a git credential helper, `whoami`, `sessions`, `revoke-all`, `audit`. |
| Agent-shell integration | `agent-env/` | A `gh` shim and a git config, active only in agent shells. |

**Login.** `agent-identity login` listens on a random `127.0.0.1` port and
opens GitHub in the browser. After GitHub authorizes the App, the broker reads
your login, revokes the GitHub user token immediately, checks your team
membership, and redirects the browser back to the loopback port with a one-time
code. The CLI trades that code (plus a secret only it knows) for a 30-day
session. A login link sent to someone else cannot deliver a session to the
person who started it, and no GitHub user token is ever stored.

**Minting.** `agent-identity token --repo api` asks the broker for a token for
`your-org/api`. The broker checks the session and team membership (cached five
minutes), validates the request, caps the permissions at both `MAX_PERMISSIONS`
and what the installation was granted, mints an installation token with the App
JWT, logs it, and returns it. The CLI caches it until ten minutes before expiry.
Mints are rate-limited per session, and login starts per IP.

**Agent shells.** `agent-env/install.sh` sources `agent-env.sh` from your shell
startup files. In a shell where a configured variable marks an agent (for
example `CLAUDECODE`, set by Claude Code), it:

- puts the `gh` shim first on `PATH`. Commands that target one of your org's
  repositories (through `-R`, a URL, an `owner/name` argument, `gh api
  repos/<org>/…`, or else the current checkout's `origin`) run with a bot token
  for that repository. Account-level commands and other orgs' repositories
  pass through to your personal login, as `AGENT_IDENTITY_PERSONAL` allows
  (see below). For commands routed to the bot: if minting fails, or the bot
  lacks a permission the command needs, the shim refuses rather than quietly
  using your login. A write never falls back to your login, because a person
  is often an org admin and borrowing that would let an agent do what the bot
  is denied. For the same reason, writes to your org's org-level endpoints,
  numeric-id endpoints (`repositories/<id>`), GraphQL mutations outside an org
  checkout, and secret or variable writes are refused outright;
- loads a git config through `GIT_CONFIG_COUNT`, so in repositories with a
  remote in your org, commits are authored by the bot, SSH remotes are routed
  through HTTPS, and git authenticates with broker tokens only.

Human shells are untouched. Set `AGENT_IDENTITY_DISABLE=1` to opt a shell out
and `AGENT_IDENTITY_DEBUG=1` to see which identity is used.

**What still uses your personal login.** By default
(`AGENT_IDENTITY_PERSONAL=allow`), any `gh` command the shim cannot tie to one
of your org's repositories runs as you, exactly as in your own terminal: other
orgs' repositories, account commands, `gh project … --owner <org>`, team
endpoints, GraphQL sent from a file, and `gh auth token` outside an org
checkout (which prints your token). Set `AGENT_IDENTITY_PERSONAL=read` to let
agents only *read* with your login (writes and `gh auth token` are refused), or
`deny` to keep agent shells off your login entirely. `read` judges commands by
name (`list`, `view`, a GET request, an inline GraphQL query); a `gh` extension
with a `list` subcommand runs its own code with your login, so prefer `deny`
where agents need nothing personal. An exported `GH_TOKEN` or
`GITHUB_TOKEN` makes the shim step aside.

## Set up

Requirements: [Bun](https://bun.sh), `jq`, `git` 2.36 or newer, `gh`, and a
Cloudflare account with [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
logged in. `~/.local/bin` must be on `PATH` (the CLI is linked there, and git
calls it as a credential helper). You need to be an owner of the GitHub org.

1. **Make your instance** (see [Keeping your instance up to date](#keeping-your-instance-up-to-date)
   for which way to create it), then `bun install`.
2. **Configure and deploy the broker.**
   ```sh
   cp worker/wrangler.example.toml worker/wrangler.toml
   (cd worker && wrangler kv namespace create agent-identity-state)  # put the id in wrangler.toml
   # edit GITHUB_ORG, GITHUB_TEAM, account_id and optionally MAX_PERMISSIONS
   bun run deploy                                               # note the workers.dev URL
   ```
   Until the App exists, the broker refuses every request.
3. **Create the App.** As an org owner:
   ```sh
   bun scripts/create-app.ts --org <your-org> --broker https://<your-broker-url>
   ```
   Click **Create GitHub App** in the browser. The script stores the key and
   client secret as Worker secrets, records the App's non-secret ids in
   `worker/wrangler.toml`, and redeploys. Then install the App on your org
   using the link it prints. If agents should start workflows, add
   `--actions-write` here *and* allow `"actions":"write"` in `MAX_PERMISSIONS`;
   the broker's cap applies on top of what the App is granted.
4. **Log in** on each machine, once per 30 days:
   `bun cli/agent-identity.ts login --broker https://<your-broker-url>`.
5. **Wire agent shells** on each machine: `agent-env/install.sh`. Then open a
   new agent shell and check `command -v gh` points at
   `~/.local/share/agent-identity/bin/gh`.

### Configuration

| Setting | Where | Meaning |
| --- | --- | --- |
| `GITHUB_ORG`, `GITHUB_TEAM` | `worker/wrangler.toml` `[vars]` | The org, and the team (slug) whose members may log in. |
| `MAX_PERMISSIONS` | `worker/wrangler.toml` `[vars]` | JSON cap on minted permissions. Default: `contents`, `pull_requests`, `issues` write; `actions`, `checks`, `statuses` read. Repository and org administration, members, secrets, environments and Actions variables can never be write (`NEVER_WRITE` in `worker/src/lib.ts`). |
| `APP_PRIVATE_KEY`, `APP_CLIENT_SECRET` | Worker secrets | Set by `create-app.ts`. Never committed. |
| `AGENT_IDENTITY_DETECT` | `~/.config/agent-identity/env.sh` | Variables whose presence marks an agent shell. Add your orchestrator's session variable here. |
| `AGENT_IDENTITY_LABEL_VARS` | same | Variables naming the agent session; the first one set labels each token. |
| `AGENT_IDENTITY_PERSONAL` | `env.sh` or environment | `allow` (default), `read` or `deny`: what agent shells may do with your personal login for commands not routed to the bot. |
| `AGENT_IDENTITY_FALLBACK` | environment | `personal` lets a read-only command the bot is not permitted run on your login. Writes are always refused. Default: refuse. |

## Use

```sh
agent-identity token --repo api            # print a token (cached until 10 minutes before expiry)
agent-identity token --repo api --perm contents=read
eval "$(agent-identity env)"               # GH_TOKEN plus bot git identity for this checkout's repo
agent-identity audit --sha <sha256>        # which session minted a token
agent-identity sessions | revoke-all | logout
```

## Keeping your instance up to date

GitHub's **Use this template** button copies the template once; it does not
sync afterwards. Make your instance a new **private** repository, not a GitHub
fork: a fork of a public repository is public. To keep taking improvements:

- **Keep all your values in instance-only files.** Your instance should differ
  from the template only in `worker/wrangler.toml` (org, team, App ids, Worker
  name, KV id; no secrets) and, if you like, an `INSTANCE.md`. The template
  never contains those files, so merges never conflict on them. Put code
  changes in the template (or your fork of it), not in the instance.
- **Track the template as `upstream`.**
  - *Recommended:* create your instance by cloning the template and pushing it
    to a new private repository. History is shared, so updates are ordinary
    merges:
    ```sh
    git clone <template URL> my-agent-identity && cd my-agent-identity
    git remote rename origin upstream
    git remote add origin <your private repo URL> && git push -u origin main
    # later:
    git fetch upstream && git merge upstream/main
    ```
  - *If you used the button:* add the remote and merge once with
    `git merge --allow-unrelated-histories upstream/main`, resolving conflicts
    in favour of the template; later merges are ordinary.
- **Check for drift.** `scripts/upstream-diff.sh` lists template commits you
  have not merged and fails if any file other than the instance-only ones
  differs from the template.

## Prior art, and how this differs

- **[octo-sts](https://github.com/octo-sts/app)** (Chainguard) is a security
  token service for GitHub: workloads with an OIDC identity (CI jobs, cloud
  workloads) exchange it for scoped installation tokens according to trust
  policies stored in each repository. It is the right tool when the caller
  already has an OIDC identity. A laptop agent session does not, so this
  template uses a team-gated human login instead.
- **[octobroker](https://github.com/openabdev/octobroker)** is a GitHub gateway
  for AI agents that runs on Kubernetes or ECS. Agents hold a broker API key;
  the broker enforces per-agent tool and repository policy, proxies GitHub's
  MCP server, REST and git, and mints repo-scoped App tokens. It is a fuller
  policy gateway, with infrastructure to run.
- **[ghapp-cli](https://github.com/operator-kit/ghapp-cli)** gives agents an App
  identity for `git` and `gh` on one machine. The App's private key is
  configured on that machine.

This template differs in that:

- **there is no infrastructure to run:** one Cloudflare Worker plus KV;
- **the key never touches a laptop:** it moves from the manifest flow into a
  Worker secret;
- **a human logs in, gated by GitHub team membership,** and no GitHub user
  token is kept;
- **routing is transparent and per shell:** agents keep using plain `git` and
  `gh`, and only agent shells are affected;
- **every token carries per-session provenance**, kept in the broker's audit
  log.

## Limits and residual risk

Read this before relying on it.

- **Agents that run as your OS user can read the session file.** On a laptop
  where agents run unsandboxed as you, they can read
  `~/.config/agent-identity/session.json` and mint tokens until it expires (30
  days) or you revoke it (`agent-identity revoke-all`). That is the accepted
  trade: every token is still one hour, narrowed, capped, rate-limited and
  logged. It is not containment. For containment, run agents as a different
  user or in a sandbox that cannot read your config directory.
- **This does not remove your personal credentials.** It stops agents acting
  as you *by default* on your org's repositories. With the default
  `AGENT_IDENTITY_PERSONAL=allow`, other `gh` commands still run as you (see
  "What still uses your personal login"). And if your personal `gh` login, SSH
  keys or browser sessions are reachable from agent shells, a determined agent
  can bypass the shim and use them directly. Use `read` or `deny`, and move or
  lock those credentials separately.
- **Remote URLs must use the org's exact letter case.** git's `includeIf`,
  `insteadOf` and per-URL credential settings match case-sensitively, so a
  remote written `github.com/MYORG/x` when the config says `myorg` skips the
  bot and uses your personal credential helper. Keep remotes in one case, or
  add the variants to the generated `agent.gitconfig`.
- **A started login can be completed in someone else's browser.** GitHub skips
  the consent screen for an App the person already authorized, so a link from
  a login someone else started makes the victim's browser request
  `127.0.0.1:<port>/callback?code=…`. Only a listener on the victim's own
  machine could use that code, together with the starter's secret; treat
  unexpected login links like any phishing link.
- **Anyone who can deploy the Worker can read its secrets.** Deploy rights on
  the Cloudflare account are equivalent to holding the App key. Keep them
  narrow, and do not leave a deploy-capable Wrangler login where agents run.
- **Revocation is not instant.** Sessions and membership checks live in
  Cloudflare KV, which is eventually consistent: a logout, `revoke-all` or
  team removal can take about a minute to apply everywhere, and the
  membership cache is five minutes. Tokens already minted stay valid until they
  expire (one hour) unless revoked at GitHub.
- **Branch protection is your real gate.** A token with `contents: write` can
  push any branch that rules do not protect. Protect your default and release
  branches with rulesets that do **not** list the App as a bypass actor. If you
  deliberately let agents push a release branch, keep force-push, deletion and
  required-CI rules in a separate ruleset that nobody can bypass.
- **Workflows and Actions.** Pushes by App tokens trigger workflows. Do not
  grant `workflows` write unless agents must edit `.github/workflows`, and
  keep deployment secrets in environments with branch restrictions.
- **Some harnesses reset `PATH`** after shell startup files run, which hides
  the `gh` shim while the git half (environment variables) still applies.
  Check `command -v gh` inside your agent shells. If it is wrong, put the shim
  directory on `PATH` in the harness's own settings. Non-interactive bash reads
  none of the startup files unless `BASH_ENV` points at one.
- **The audit log is shared within the team.** Any logged-in team member can
  read every mint record (who, which device, which repositories, which
  session label). It holds token hashes, never token values.
- **Copilot inference cannot use App tokens** at the time of writing; this
  template covers GitHub API and git access.

## Develop

```sh
bun test            # broker validation, JWT signing, agent-env detection, gh shim routing
bun run typecheck
```
