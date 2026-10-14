## What and why

<!-- A short description. Link the issue if there is one. -->

## What does this read, keep and send?

<!-- The agent's contract is metadata only. State what the change reads on the user's machine, what it keeps locally, and what can become public. "Nothing new" is a fine answer. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`): I certify the [Developer Certificate of Origin](https://developercertificate.org/) and license my contribution under Apache-2.0
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] No content, paths, secrets or real session data in code, fixtures, logs or this description
- [ ] New or changed adapter: manifest `reads` is accurate and there is a scenario in `test/adapters/canary.test.ts`
- [ ] No new network destination, no telemetry, no new runtime dependency (or an issue discussing it)
- [ ] Docs updated if behaviour changed
