# Testing

```
npm test          # node --test test/  — 321 tests
```

## Suites

- `cli-core.test.mjs` — per-command unit/integration coverage (init, comment,
  resolve/reopen, serve, commit/share).
- `cli-suggest-accept.test.mjs` — suggestions: propose old->new, the owner
  Markdown-editor write path, and Accept applying the change to the doc.
- `anchor.test.mjs` / `render.test.mjs` — anchor resolution and the rendered
  review view (comments + suggestion markers).
- `cli-serve-summary-mentions.test.mjs` — role-tailored summaries and @mentions
  in the `seal serve` HTTP API.
- `e2e-full-flow.test.mjs` — one throwaway git repo, full lifecycle in a single run:
  init → anchored + general comment → suggest → reply → resolve → dismiss →
  accept (asserts doc.md changed + content-hash drift) → edit via `/api/doc`
  (asserts hash change) → commit → push. Drives **both** the CLI and the
  `seal serve` HTTP API.
- `cli-pr.test.mjs` — the `gh`-based PR flow without touching GitHub. This is how
  approval happens locally: `seal pr` opens a normal GitHub PR and the team
  approves/merges or comments on it on GitHub — Seal does not track approval
  state itself.
- `pr-comment-mirror.test.mjs` — mirroring review comments onto the GitHub PR.
- `notify.test.mjs` / `serve-security.test.mjs` / `council-fixes.test.mjs` —
  notifications, serve hardening, and regression fixes.

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

Separate repo (`seal_ai`), `npm test`. The hosted tier is where the real
in-app, identity-verified (WebAuthn) approval workflow lives — stages, quorum,
submit/approve/request-changes — so its suite still covers that. (None of that
applies to the local plugin, which delegates approval to the GitHub PR.) Three
pre-existing failures were fixed: stale `review-page` assertions updated for the
intentional `md` view, and the global `rate_limit_counters` sink marked
`tenant-isolation:allow` (the guard's documented escape hatch — guard not
weakened).
