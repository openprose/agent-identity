# Threat model

This page says what agent-identity protects, whom it trusts, what each trusted
party could do if it were compromised, and what it deliberately does not
protect against. Read it together with
[Limits and residual risk](README.md#limits-and-residual-risk) in the README;
where they overlap they say the same thing.

The short version: agent-identity gives agents a separate GitHub identity and
short-lived, narrowed, logged tokens, so that what an agent does on GitHub is
attributable and bounded in time and scope. It is **not** a sandbox. An agent
that runs as your OS user is not contained by it, and your branch rulesets
remain the gate that decides what any token can change.

## Design properties

- **No hosted service, no telemetry.** Each team deploys its own broker on its
  own Cloudflare account and creates its own GitHub App. The CLI talks only to
  your broker and to `api.github.com`; the broker talks only to GitHub. Nothing
  reports to the template's authors.
- **The App's private key never lands on a laptop.** `scripts/create-app.ts`
  receives the key from GitHub's manifest flow, holds it in memory, and pipes
  it to `wrangler secret put`. It is not written to disk or printed. After
  that it exists only as a Worker secret (and at GitHub, which holds the public
  half).
- **One-hour, narrowed tokens.** Every token is a GitHub App installation
  token that expires after one hour, names at most 20 repositories, and
  carries no more than the intersection of the request, `MAX_PERMISSIONS`, and
  what the installation was granted. Only contents, pull requests, issues,
  Actions, checks, statuses, deployments, pages and discussions can ever be
  write (`WRITABLE` in `worker/src/lib.ts`), whatever the configuration says;
  everything else is read-only at most.
- **Team-gated human login, no stored user token.** Only members of one
  GitHub team get a session. The GitHub user token used to read the login is
  revoked in the same request. Membership is rechecked on every request
  (cached for five minutes), and a non-member's sessions are revoked.
- **Per-token provenance.** Each mint is logged with person, device, IP,
  agent-session label, repositories, permissions and expiry, keyed by the
  token's sha256. Token values are never stored by the broker.
- **Refusals in the `gh` shim.** For commands routed to the bot, the shim
  refuses rather than falling back to the person's login when minting fails
  or the bot lacks a permission. It refuses outright writes to org-level
  endpoints, numeric-id endpoints, GraphQL mutations outside an org checkout,
  and secret or variable writes. These refusals prevent *accidental*
  escalation through a person's (often admin) login. They are not a boundary
  against an agent that deliberately calls the real `gh` or uses your
  credentials directly. The same goes for the shim's environment switches:
  an agent can set `AGENT_IDENTITY_SHIM_TOKEN=1`, `AGENT_IDENTITY_RESPECT_GH_TOKEN=1`
  or `AGENT_IDENTITY_DISABLE=1` itself, which gains it nothing it did not
  already hold.
- **Rate limits.** Mints are limited per session and login starts per IP.

## Assets

| Asset | Where it lives | Lifetime | Who can use it |
| --- | --- | --- | --- |
| App private key | Worker secret `APP_PRIVATE_KEY` | Until rotated in the App's settings | The Worker. Anyone holding it can mint installation tokens with the App's full installed permissions on every repository the App is installed on, with no logging by the broker. |
| App client secret | Worker secret `APP_CLIENT_SECRET` | Until rotated | The Worker, to complete logins and revoke user tokens. With the client id it lets someone run the App's user-login flow and revoke user tokens issued to the App. It cannot mint installation tokens. |
| Broker sessions | Bearer token in `~/.config/agent-identity/session.json` (mode 0600); its sha256 in KV | 30 days, or until logout, `revoke-all`, or team removal | Anyone who can read the file can mint tokens as that person until the session ends. |
| Minted tokens | Returned to the CLI; cached in `~/.cache/agent-identity/` (mode 0600) until ten minutes before expiry; in process environments (`GH_TOKEN`) | One hour | Anyone holding one can act as the bot within its repositories and permissions until it expires. |
| Audit log | KV (`audit:` and `audit-sha:` keys, kept 400 days) and the Worker's logs on Cloudflare | 400 days in KV; logs per your Cloudflare settings | Readable by every logged-in team member and by anyone with access to the Cloudflare account. Holds token hashes, never values. |
| Login records | KV, hashed secrets only | Ten minutes | Used only to complete one login. |

## Trusted parties

Each party below is trusted. The table says what it could do if it were
compromised or malicious, and what the design does about it.

### GitHub

GitHub issues and enforces every token, runs the OAuth login, answers the
team-membership check, and enforces branch rulesets.

- **If compromised:** everything. GitHub could issue tokens, misreport
  membership, or ignore rulesets.
- **What the design does:** nothing beyond relying on GitHub's own controls.
  This is out of scope; every GitHub integration has the same dependency.

### Cloudflare, and whoever holds deploy rights on the account

The broker runs on Cloudflare Workers; its secrets, KV state and logs live in
your Cloudflare account.

- **If compromised, or if anyone with deploy rights misuses them:** they can
  deploy code that reads `APP_PRIVATE_KEY` and mint any token the App's
  installation allows, without broker logging. They can read and alter
  sessions and the audit log in KV, and read the Worker's logs. **Deploy
  rights on the account are equivalent to holding the App key.**
- **What the design does:** keeps the key off laptops, so deploy rights are
  the single place to guard. It cannot stop a deploy-rights holder.
- **What you should do:** give Workers deploy rights on this account to as few
  people as possible, prefer scoped API tokens over broad account roles, and
  never leave a deploy-capable Wrangler login or API token where agents run.
  If you suspect misuse, generate a new private key in the App's settings,
  delete the old one, store the new one with `wrangler secret put`, and review
  the App's activity in GitHub's audit log.

### Members of the configured GitHub team

- **What they can do by design:** log in, mint tokens for any repository the
  App is installed on (up to the permission cap), read the whole audit log
  (who, which device, which repositories, which session label), and list or
  revoke their own sessions.
- **If an account is compromised or a member is malicious:** they can do all
  of the above until removed from the team. Actions they take through the bot
  are logged with their login.
- **What the design does:** rechecks membership on every request (five-minute
  cache), revokes all of a removed member's sessions on their next request
  after that, treats a missing team as a configuration error rather than a
  removal,
  and records every mint.
- **What you should do:** keep the team small, require two-factor
  authentication in the org, and install the App only on the repositories
  agents need.

### The machine, and the OS user that runs the CLI and the agents

- **If an agent, or anything else running as that user, misbehaves:** it can
  read `session.json` and the token cache and mint tokens until the session
  ends; call the real `gh` and bypass the shim; and use any personal
  credentials reachable from that user (your `gh` login, SSH keys, browser
  sessions). A compromised OS can do all of that and more.
- **What the design does:** bounds what each token can do (one hour, named
  repositories, capped permissions), rate-limits minting, labels every token
  with the agent session that asked for it, and gives you `revoke-all`. It
  routes agent shells to the bot by default so that normal agent work does not
  run as you.
- **What it does not do:** contain an agent. See non-goals below.
- **What you should do:** for containment, run agents as a different OS user
  or in a sandbox that cannot read `~/.config/agent-identity` or your personal
  credentials. Keep the default `AGENT_IDENTITY_PERSONAL=read`, or use `deny`,
  so agent shells cannot write with your personal login.

### The template's code and its dependencies

This includes the Worker, the CLI, the shim and scripts, and the tools and
packages they run on: Bun, Wrangler, `gh`, `git`, `jq`, and the npm packages
in `package.json` and `bun.lock`.

- **If compromised:** malicious Worker code holds the App key. Malicious CLI
  or shim code runs with the person's privileges in every agent shell.
  Wrangler and Bun see the private key once, during `create-app.ts`, and
  Wrangler holds deploy credentials.
- **What the design does:** the Worker has no runtime npm dependencies (only
  type definitions and the TypeScript compiler at development time); the code
  is small enough to read; the lockfile is committed.
- **What you should do:** install Bun and Wrangler from their official
  sources, install with the lockfile (`bun install --frozen-lockfile`), and
  review dependency changes in upgrades like any other code change.

### The person who merges template updates into your instance

- **If careless or malicious:** a merge decides which code will run with the
  App key and in every agent shell, so a bad merge has the same effect as a
  compromised template.
- **What the design does:** keeps instance values in instance-only files, so
  every upgrade is a reviewable diff of template code; recommends tagged
  releases with release notes; an optional update workflow may only open a
  pull request, never push or deploy. See [UPGRADING.md](UPGRADING.md).

## Not trusted

- **Agents.** Agents may be wrong, confused or prompt-injected. The design
  assumes an agent may try anything its shell allows. Tokens, caps, logging and
  rulesets bound what it can do on GitHub through the bot; the OS boundary (or
  its absence) decides everything else.
- **The network between the CLI, the broker and GitHub.** All traffic is
  HTTPS. The CLI refuses a non-HTTPS broker and sends the session only to the
  broker that issued it. The login code travels only to `127.0.0.1`.
- **People outside the team.** The broker is reachable on the internet. Its
  unauthenticated endpoints are `/health`, login start (rate-limited per IP),
  the GitHub callback, and login finish (which needs a secret held only by the
  CLI that started the login, and allows five code attempts).

## Non-goals and residual risk

These are accepted. They match the README's "Limits and residual risk".

- **Containment of agents that run as your OS user.** Such an agent can read
  the session file and mint tokens for up to 30 days, and can bypass the shim.
  Every token is still one hour, narrowed, capped, rate-limited and logged.
- **Removing your personal credentials.** agent-identity changes the
  *default* identity in agent shells. It does not hide your `gh` login, SSH
  keys or browser sessions from processes running as you.
- **Deciding what a token may change.** A token with `contents: write` can
  push any branch that rules do not protect. **Branch rulesets are the real
  gate**: protect default and release branches with rulesets that do not list
  the App as a bypass actor. Pushes by App tokens trigger workflows, so keep
  deployment secrets in environments with branch restrictions. The broker
  never grants `workflows` write.
- **Instant revocation.** Sessions and membership checks live in Cloudflare
  KV, which is eventually consistent: logout, `revoke-all` or team removal can
  take about a minute to apply everywhere, and the membership cache adds up to
  five minutes. Already-minted tokens stay valid until they expire (one hour).
  To stop everything at once, suspend or uninstall the App on the org.
- **Protection against the trusted parties above.** A compromise of GitHub,
  of the Cloudflare account, of deploy rights, or of the code you deploy
  defeats the design.
- **Privacy inside the team.** The audit log is shared with every team member.
- **Login phishing.** A login someone else started can be completed in your
  browser if you open their link; only a listener on your own machine could
  use the resulting code. Treat unexpected login links as phishing.
- **Remote spellings.** Credentials reach the broker for any letter case, but
  the bot commit identity follows git's case-sensitive `includeIf`, and SSH
  host aliases are not rewritten (such pushes use your SSH key).
- **Harnesses that reset `PATH`** hide the shim while git's half of the
  integration still applies.
