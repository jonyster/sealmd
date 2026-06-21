# Testing

```
npm test          # node --test test/  — 342 tests
```

## Suites

- `cli-*.test.mjs` — per-command unit/integration coverage (init, comment, suggest/accept, approvals, serve, commit/share).
- `e2e-full-flow.test.mjs` — one throwaway git repo, full lifecycle in a single run:
  init → anchored + general comment → suggest → reply → resolve → dismiss →
  accept (asserts doc.md changed + content-hash drift) → edit via `/api/doc`
  (asserts hash change + approvals re-open) → submit → approve + request-changes →
  render → commit → push. Drives **both** the CLI and the `seal serve` HTTP API.
- `cli-pr.test.mjs` — the `gh`-based PR flow without touching GitHub.

## Two test fixtures worth knowing

- **Local bare remote.** Tests `git init --bare` a second tmp dir and use it as
  `origin`, so push/commit are exercised with zero network and no GitHub repo.
- **Fake `gh`.** `cli-pr.test.mjs` puts a stub `gh` executable on `PATH` that
  fakes `pr create`/`pr view`/`auth status`/`repo view`, so `corePR` branch-cut,
  commit, push and idempotency are asserted without a real PR.

## Opt-in: real GitHub PR

One `cli-pr.test.mjs` case is skipped unless you set `SEAL_E2E_GH=1` — it runs
`corePR` against your real `gh` login. Creates a real PR; use a throwaway repo.

## Hosted app (sealmd.net)

Separate repo (`seal_ai`), `npm test`. Three pre-existing failures were fixed:
stale `review-page` assertions updated for the intentional `md` view, and the
global `rate_limit_counters` sink marked `tenant-isolation:allow` (the guard's
documented escape hatch — guard not weakened).
