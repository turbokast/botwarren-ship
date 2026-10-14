# Writing an adapter

An adapter teaches the agent to see **one** AI coding tool: it turns whatever that tool exposes locally (log file names, a loopback HTTP API, a socket) into a stream of small, validated *observations*. The agent does the rest: attributing the session to a project you approved, merging the same real session seen by several adapters into one crew member, and projecting the result into the public, enum-only feed.

Read [CONTRIBUTING.md](../CONTRIBUTING.md#ground-rules) first. The short version of the rules that decide whether an adapter can be merged:

1. **No content, ever.** An observation has no free-text field. Anything text-like that exists on the user's machine (a folder name, a log file name) may only go in `local`, which stays in the private journal and ops room.
2. **Read-only and allow-listed.** The adapter gets a context with a GET-only, loopback-only, exact-path HTTP client and a file reader confined to the roots it declares. It cannot do anything else, and the tests prove it.
3. **It declares what it reads**, in plain words, and users can read that with `botwarren adapters explain <id>`.
4. **It has a canary test scenario.** No scenario, no merge. See [The canary rule](#the-canary-rule).

The adapter API is versioned (`ADAPTER_API_VERSION = 1`, [`src/adapters/api.ts`](../src/adapters/api.ts)); read that file, it is short and heavily commented. The existing adapters are the best examples: [`gemini.ts`](../src/adapters/gemini.ts) (file names only, the smallest), [`opencode.ts`](../src/adapters/opencode.ts) and [`ninox.ts`](../src/adapters/ninox.ts) (loopback HTTP), [`herdr.ts`](../src/adapters/herdr.ts) (a socket), [`claude.ts`](../src/adapters/claude.ts) (session logs).

## The shape of an adapter

```ts
interface Adapter {
  manifest: AdapterManifest;                                   // id, version, platforms, reads[], capabilities, upstream, summary
  detect(env: DetectEnv): Promise<Detection>;                  // is the tool here? read-only probes only
  start?(ctx: AdapterContext): Promise<void>;                  // optional, must not block
  poll(ctx: AdapterContext, now: Date): Promise<Observation[]>;
  stop?(): Promise<void>;
}
```

`poll` returns observations of four kinds:

| Kind | What it says | Notable fields (all enums, bounded integers or safe keys) |
|---|---|---|
| `session` | a session exists and what it is doing | `key`, `status`, `harness`, `role` (`main`, `subagent`, `pair`), `projectId` (from `ctx.attribute()`), `certainty` (`observed` or `inferred`), optional `local` |
| `session.ended` | it is gone | `key`, `reason` |
| `activity` | a tool error, a step or a context-fill change | `act`, `toolCategory`, `step`, `context`, `at` |
| `adapter.health` | the adapter itself is ok, degraded or the tool's version is unsupported | `state`, `code` |

Keys that do not look like ids (`[A-Za-z0-9][A-Za-z0-9:._\-/]{0,127}`) are replaced by a hash (`h:<sha256[:24]>`) by the host, so a path can not slip through as a key. Unknown fields drop the whole observation (the schemas are strict).

## Steps

1. **Find out what the tool exposes, and how you know.** Prefer the least invasive source: file names and write times, then a documented local API, then a log header. Never open a file that holds conversation content if its name and mtime are enough (the Gemini CLI adapter reads no file content at all). Record the tool version you looked at.
2. **Create `src/adapters/<tool>.ts`** implementing `Adapter`.
   * `manifest.reads`: one entry per file, folder, endpoint or socket, with `target` and `keeps` ("only file names and write times of ...").
   * `manifest.upstream.verification`: `live` only if you recorded the fixture from a real install of the tool and wrote its version in `tested`; `documented` if it follows the tool's documentation; `unverified` if you are not sure. Be honest: it is shown to users.
   * Take everything through `ctx.http` and `ctx.fs`. Do not import `node:fs`, `node:http` or `node:child_process` in an adapter.
   * Log only through `ctx.log(code, n?)`: a fixed code and one integer.
3. **Register it** in `src/adapters/registry.ts` (default `"auto"`: it is polled only while the tool is detected) and add its id to `AdapterId` in `api.ts`. If the public event schema needs a new harness value, that is a change to the public contract and starts with an issue.
4. **Add fixtures** in the tool's documented formats, with the tool version in a comment.
5. **Add tests**: normal operation; the tool absent; the tool answering with an unexpected shape or the wrong service on the port (`adapter.health` with `unexpected_shape`, never a crash); forbidden paths never producing a request (`policy.test.ts` style); and the canary scenario below.
6. **Document it**: a row in the adapters table in the [README](../README.md#tools-it-can-see) and [ARCHITECTURE.md](ARCHITECTURE.md#2-adapters), and an entry under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).
7. **Open the pull request** and answer the question in the template: what does it read, what does it keep locally, what can become public?

## The canary rule

[`test/adapters/canary.test.ts`](../test/adapters/canary.test.ts) is the gate every adapter must pass. For each adapter it builds a realistic fixture of the tool's data and plants a unique **content canary** everywhere real machines keep secrets: prompts, tool output, titles, summaries, notes, costs, repository names, environment values, base instructions and extra fields the tool might add in a newer version. It plants a **path canary** in folder names. Then it runs the adapter and fails if

* the content canary appears **anywhere**: in an observation, a canonical event, the public projection (built by the real `projectPublic`) or a log line;
* the path canary appears anywhere except `local.cwd`.

A self-test in the same file proves the checker really fails for an adapter that leaks, so a green run means something.

To add your scenario, add an entry to the `scenarios` array in that file: `build(home)` writes your fixtures with the canaries under a temporary home and returns your adapter (and optionally a `step()` that changes the fixture between two polls, to test updates). Copy the closest existing scenario. The shared helpers are in [`test/adapters/kit.ts`](../test/adapters/kit.ts) and [`test/helpers.ts`](../test/helpers.ts).

If your scenario can only pass by weakening `assertNoLeak`, the adapter is reading something it should not. Change the adapter, not the test.

## Running the tests

```sh
pnpm install
pnpm exec vitest run test/adapters/canary.test.ts      # the gate
pnpm exec vitest run test/adapters                      # all adapter tests
pnpm lint && pnpm typecheck
```

Run one test file at a time on a busy machine; some tests open real loopback sockets.

## What a reviewer checks

* `manifest.reads` is complete and honest, and `botwarren adapters explain <id>` reads clearly.
* Nothing outside `local` can hold user text; `local` holds only what the private ops room needs.
* Detection is read-only and cheap; a missing or misbehaving tool degrades to `adapter.health`, never to an exception.
* Caps: a tool with thousands of sessions must not stall the agent (the host enforces a per-poll timeout and session caps, and the adapter should also stop early).
* The canary scenario, the allow-list tests and the fixtures are included, and `upstream.verification` is truthful.
