# Contributing to the Botwarren ship agent

Thanks for helping. The agent has one job that must never regress: **it reads and sends metadata only**. Most review time goes to that, so please read this page before opening a pull request. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Vulnerabilities go to support@turbokast.com, not to public issues (see [SECURITY.md](SECURITY.md)).

## Licence and sign-off (DCO)

The project is licensed under the [Apache License 2.0](LICENSE). **Contributions are accepted under the same licence** (Apache-2.0, as described in section 5 of the licence): you license your contribution to TurboKast Ltd and to everyone who receives the software under those terms.

We use the [Developer Certificate of Origin](https://developercertificate.org/) instead of a contributor licence agreement. Certify it by signing off every commit:

```sh
git commit -s -m "Describe the change"
```

This adds a `Signed-off-by: Your Name <you@example.com>` line, which means you have the right to submit the work under the project's licence (DCO 1.1, reproduced at the link). Use your real name. A pull request with unsigned commits cannot be merged; `git rebase --signoff main` fixes a branch.

## Ground rules

1. **No content, ever.** Adapters emit only enums, bounded integers and id-like keys. Anything else that exists on the user's machine (folder names, titles, summaries, command lines, output) may exist only in the private `local` block and must never reach an event, a log line or the network.
2. **Read-only by default.** An adapter must not write to another tool's configuration or send it input. Anything that edits another tool's settings is opt-in, prints a diff first, and needs an explicit yes.
3. **Allow-lists, not deny-lists.** Local HTTP is GET-only on loopback with an exact path allow-list; files are confined to declared folders; Herdr's RPC is `agent.list` and `ping` only. If you need one more endpoint, justify it in the pull request and add the test that proves everything around it stays unreachable.
4. **Updates are signed or they do not happen.** Never add a code path that downloads or executes something that is not listed in a verified manifest with a matching hash.
5. **No telemetry.** The agent sends the public status feed and nothing else. No analytics, no crash reporting, no "phone home".
6. **No new runtime dependencies without discussion.** The agent ships as dependency-free bundles; `zod` is the only runtime package. Open an issue first if you think another is needed.

## Adding a tool (adapter)

1. Implement `Adapter` (`src/adapters/api.ts`): `manifest` (declare every file and endpoint in `reads`: users see this text through `botwarren adapters explain <id>`), `detect` and `poll`.
2. Register it in `src/adapters/registry.ts` (default `"auto"`: read only while the tool is detected).
3. Add fixtures from the tool's documented formats. Mark `upstream.verification` as `documented` or `unverified` until you have recorded a live fixture, and note the tool version you recorded it with.
4. **Add a scenario to `test/adapters/canary.test.ts`. An adapter without a canary scenario will not be merged.** The canary test plants a secret string in prompts, tool output, titles, environment values, folder names and extra fields of your fixture and fails if any of it reaches an event, the public projection or a log line.
5. Test allow-list enforcement (forbidden paths never produce a request) and "wrong service on this port" if the tool uses a loopback API.
6. Say in the pull request what the adapter reads, what it keeps locally and what can become public.

## Development

```sh
pnpm install
pnpm typecheck          # strict TypeScript; no enums, no parameter properties (Node runs the sources directly)
pnpm test               # vitest, one file at a time
shellcheck packaging/*.sh        # installers must stay shellcheck clean
```

Requires Node.js 22.18 or newer. Run one test file at a time on a busy machine (`pnpm exec vitest run test/adapters/canary.test.ts`); some tests start real child processes and loopback sockets. Windows and macOS code paths are tested with injectable host objects (`Host` in `src/paths.ts`) because most development happens on Linux; changes to installers, services or signing need a manual run on the real operating system, noted in the pull request.

`src/vendor/core/` is a generated copy of the shared event schema and projection. Do not edit it in a pull request: changes to the public contract go through an issue first, because they change what the agent can publish.

## Pull requests

Small, focused, with tests. State what the change reads, keeps and sends. Do not commit keys, tokens, `.env` files, databases or downloaded runtimes (the Node cache and `release-*.key` files are git-ignored; keep it that way). CI runs typecheck and tests on Linux, macOS and Windows; pull requests from forks run without any secrets.
