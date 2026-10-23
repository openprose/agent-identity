# Contributing

Thanks for looking. This is a template that teams copy and run themselves, so
changes are judged by whether they keep it small, auditable and safe to adopt.

- **Security problems:** do not open an issue. Use a private security advisory
  on this repository (see [SECURITY.md](SECURITY.md)).
- **Issues and pull requests** are welcome. Describe the problem first for
  anything larger than a fix, since every new dependency, service or
  permission is a cost for every adopter.
- **Changes need tests.** `bun test` and `bun run typecheck` must pass. Changes
  to the gh shim or `agent-env/` need a test in `test/` that shows the routing
  or refusal.
- **Keep the trust boundary.** No hosted services, telemetry, or keys on
  laptops; no new write permissions without a documented reason (see
  `WRITABLE` in `worker/src/lib.ts` and [THREAT_MODEL.md](THREAT_MODEL.md)).
- **Docs move with code.** Update the README, CHANGELOG and, for breaking
  changes, UPGRADING.

By contributing you agree that your contribution is licensed under the MIT
license in [LICENSE](LICENSE).
