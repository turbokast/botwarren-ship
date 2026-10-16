# Architecture

How the ship agent is put together: the adapter contract, packaging, and the signed update design. For what the agent sends and why it is safe, start with the [README](../README.md) and <https://botwarren.com/trust.html>.

Verification vocabulary: **live** = ran on a real machine against the real component; **fixture** = tested against documented formats or synthetic servers; **unverified** = written to the documentation but never run against the real thing.

## 1. Data flow

```
adapters (read local tools, read-only)  ->  host (validates, merges, one crew member per session)
   ->  local service on 127.0.0.1: canonical journal (private.db), ops room
   ->  one-way projection (src/vendor/core/projection.ts): allow-listed, enum-only
   ->  outbox with a 30-120 s delay  ->  public.db  ->  replicator  ->  the Botwarren service you configured
```

Only `public.db` is ever read by the replicator. The private journal (which may hold local folder names so the ops room can show you what is being published) never leaves the machine. The delay is not a privacy filter: classification happens first, the delay only gives you time to pause.

Source map: `src/adapters/` (adapter API, host, one file per tool), `src/local/` (local service, stores, replicator), `src/readers/` (metadata readers for session logs, sub-agents, context fill and code size), `src/update/` (signed updates), `src/launcher/` (supervisor), `src/vendor/core/` (the public contract), `scripts/` (release build and signing), `packaging/` (installers, package-manager templates).

## 2. Adapters

An adapter turns what ONE tool exposes locally into a stream of `Observation`s. It implements `manifest`, `detect(env)`, `poll(ctx, now)` and optionally `start` and `stop`. Observation kinds: `session`, `session.ended`, `activity`, `adapter.health`. API version 1 is in `src/adapters/api.ts`.

Privacy by construction (enforced by the host, not by adapter authors):

| Rule | Enforcement | Test |
|---|---|---|
| Observations contain only enums, bounded integers, validated timestamps and safe keys. There is no free-text field. | Strict zod schemas; an unknown field drops the whole observation and is counted. Keys that do not look like ids become `h:<sha256[:24]>`. | `test/adapters/host.test.ts` |
| Text that exists on the user's machine (cwd, a log file name) may appear only in `local`, which goes to the private journal and ops room and never into a public projection. | `Local` allows `cwd`, `log`, `pid` and two enums. | `test/adapters/canary.test.ts` |
| Adapters get read-only, allow-listed access only. | `ctx.http` is GET-only, loopback only, exact path allow-list, no redirects, 2 MB cap; `ctx.fs` is limited to the roots the manifest declares, refuses symlinks, caps reads at 1 MiB; the Herdr client can only send `agent.list` and `ping`. | `policy.test.ts`, `herdr.test.ts`, `ninox.test.ts` |
| Logs cannot carry user text. | `ctx.log(code, n?)` takes a fixed code and one integer; adapter failures are logged as an error code, never a message. | `host.test.ts`, `canary.test.ts` |
| One crew member per real session. | The host merges observations sharing a correlation id or key; field authority is ordered per field. | `host.test.ts` |
| Adapters cannot stall the agent. | Concurrent polls with a 15 s timeout, per-poll and session caps, background detection. | `host.test.ts` |

**Code map** (opt-in, default off; `src/readers/codemap.ts`, `src/readers/sessionlog.ts`): while on, the Claude Code log reader passes the path argument of a file tool call to a probe that returns only an opaque area index; the area map is derived from `git ls-files` and `git log -1` (read-only, lowest priority, cached). Events carry an index, a closed-enum kind and a staleness bucket (`project.areas`, `session.activity` kind `area`); the projection (`projectPublic`, `projectArea`) refuses them unless the policy's `codeMap` flag is on. Folder names are hashed with a per-install salt for stable indices and never leave memory or the user-only `private/codemap.json`. The canary scenarios cover it on and off.

**The canary suite** (`test/adapters/canary.test.ts`) is the gate every adapter must pass: a fixture plants a content canary in prompts, tool output, titles, summaries, notes, costs, repository names, environment values and extra fields, and a path canary in folder names. The content canary must appear nowhere (events, public projections through the real `projectPublic`, log lines); the path canary may appear only in `private.cwd`. A self-test proves the checker fails on a leaking adapter.

| Adapter | Reads | Verification |
|---|---|---|
| `claude-code` | session log file names and mtimes, cwd of the newest lines, tool names, error flags, model maker and line (exact name dropped locally), reasoning effort level, numeric token counts (bucketed) | live |
| `codex` | rollout file names and mtimes; only `id`, `cwd`, `originator`, `source` of the first line, plus model (reduced to maker + line locally) and reasoning effort of the newest `turn_context` line | live |
| `herdr` | `agent.list` and `ping` on the Herdr socket; named sessions; sessions are never ended while Herdr is unreachable | fixture; Windows unverified |
| `ninox` | `GET /api/v1/sessions` and the events stream (as a wake-up hint only) on `127.0.0.1`; the response shape is verified before the port is trusted | fixture; unverified against a live install |
| `opencode` | 2.x: `GET /api/session/active`, `/api/session`, `/api/permission/request`, `/api/form` (only the ids of waiting sessions); 1.x: `GET /session/status` and `GET /session`. Uses `OPENCODE_SERVER_PASSWORD` from the agent's environment if set | 2.x routes and login behaviour live on an empty server, session rows from its API document; 1.x from documentation |
| `gemini-cli` | file names and write times only (no file content) | fixture from documentation; unverified live |

Configuration: `"adapters": { "ninox": { "enabled": true, "port": 8081 } }`; `enabled` is `true`, `false` or `"auto"` (default except Claude Code and Codex: polled only while the tool is detected). Commands: `botwarren adapters`, `botwarren adapters explain <id>`, `botwarren adapters enable|disable|auto <id>`. To add an adapter, see [CONTRIBUTING.md](../CONTRIBUTING.md): an adapter without a canary scenario is not merged.

## 3. Packaging

A **pinned official Node.js runtime plus dependency-free `.mjs` bundles**, per user, no administrator rights, no native binary of our own. The pinned version and the SHA-256 of every runtime archive are committed in `packaging/node-pins.json`.

Installed layout (identical inside every release archive):

```
<root>/                      Linux/macOS ~/.local/share/botwarren   Windows %LOCALAPPDATA%\Botwarren
  runtime/node/node(.exe)    the official Node binary (+ LICENSE), runtime/NODE_VERSION
  launcher/launcher.mjs      the supervisor (not replaced by silent updates)
  versions/<v>/{agent.mjs,cli.mjs,ops.html,VERSION}   immutable, side by side
  current.json               pointer {version, previous, knownGood, state trial|stable, bootCount}
  state/  logs/  uninstall.sh|ps1   [bin/botwarren.cmd on Windows]
```

Config, secret and data stay in `~/.config/botwarren-ship` and `~/.local/share/botwarren-ship` (Windows `%APPDATA%\Botwarren`, `%LOCALAPPDATA%\Botwarren\data`).

**Build** (`scripts/build-release.mjs`): targets `win-x64 win-arm64 mac-arm64 mac-x64 linux-x64 linux-arm64`. Runtime archives come from nodejs.org and must match both its `SHASUMS256.txt` and the committed pin; they are cached under `.cache/node`, re-verified on every use, and a failing cached file is deleted and fails the build. `--offline` works from the cache alone. Archives are written with fixed timestamps and sorted entries, so two builds of the same sources give identical hashes (tested). Bundles are scanned for obviously machine- or secret-specific text. Optional signing stages (Windows Authenticode, macOS Developer ID and notarisation) are in `scripts/lib/signing.mjs`; they run only when credentials are present and the host can run the tool, otherwise they skip and name the missing variables. Signing happens on the staged tree before hashing.

**Installers** (`packaging/install.sh`, `packaging/install.ps1`): per user, never elevated; the whole script is wrapped so a partial download executes nothing; they check size and SHA-256, list the archive and refuse unsafe paths, then run the extracted CLI's `verify-release`, which requires a signed manifest that contains exactly this archive's hash, **before anything is installed or started**. Installs are side by side; an upgrade starts the new version on trial. Services: `systemd --user` (Linux), a launchd LaunchAgent (macOS, label `com.turbokast.botwarren`), a per-user Scheduled Task running the bundled `node.exe` directly (Windows, no `-ExecutionPolicy Bypass`). Unverified on real Windows hardware: console-window behaviour at logon and SmartScreen reactions for unsigned scripts. Uninstallers remove only what is clearly a Botwarren install.

Homebrew and Scoop templates are in `packaging/` (not published yet). Their wrappers set `BOTWARREN_INSTALL_METHOD`, which turns the self-updater off.

## 4. Signed updates

The only thing that makes a download executable is a **signed manifest that lists it with a matching hash**. HTTPS is transport, not trust.

| Piece | File | Role |
|---|---|---|
| Manifest and schema | `src/update/manifest.ts` | monotonic `manifestVersion`, `expires`, channels, `minSupported`, `blocked`, `rollbackFrom`, per release `bundle`, `full`, staged `rolloutBp` |
| Signature | `src/update/verify.ts`, `keys.ts` | Ed25519 detached signature over the exact manifest bytes (domain-separated), keys pinned in the agent |
| Decision | `src/update/decide.ts` | pure function: what to install, if anything |
| Updater | `src/update/updater.ts` | check, verify, decide, download, sha256, extract to staging, self-test, write the pointer in trial |
| Schedule | `src/update/service.ts` | at least 6 h plus jitter, backs off on failure, restarts into a staged version only when idle |
| Policy | `src/update/policy.ts` | opt-outs, managed installs, machine policy |
| Launcher | `src/launcher/` | start, trial, health check, rollback; dependency-free |

| Threat | Mitigation |
|---|---|
| Hosting or DNS hijack, forged manifest | The signature is checked first against keys compiled into the client; nothing from an unsigned document is parsed |
| Tampered artifact | sha256 and exact size checked before extraction |
| Downgrade, rollback, freeze | The highest accepted `manifestVersion` is persisted; a lower release is refused unless the signed `rollbackFrom` lists it; `expires` bounds a freeze |
| Bad release reaches everyone | `blocked`, `minSupported`, staged rollout, then trial with automatic rollback on the client |
| Malicious archive | Entry names validated (no absolute, drive letters, `..`), regular files only, size caps, CRC checks |
| Insecure transport | `https` only (`http` only for loopback), no credentials in URLs |
| Dev key in production | Keys flagged `dev` are refused unless `BOTWARREN_UPDATE_ALLOW_DEV_KEY=1`; CI never uses one; `build-release.mjs --release` requires the production and recovery keys to be pinned |
| Compromised or lost release key | The release key is a non-exportable Cloud KMS key; any 2 of 3 offline recovery keys sign a keys document that rotates or revokes it and can raise the trust epoch; revocations are persisted; recovery keys never sign manifests |
| Updating a running file | Never: versions are side by side and the pointer swap is an atomic rename |

**State today.** `src/update/keys.ts` pins the production release key `kms-2026a` (a non-exportable Google Cloud KMS Ed25519 key usable only by the release workflow), three offline recovery keys (2 of 3 can rotate or revoke the release key), and a development key that is refused unless explicitly allowed. Signed mode is switched on per repository with the `RELEASE_SIGNING` variable. Release 0.5.0 was published in signed mode (manifest `manifest.json` and `manifest.json.sig`, signed by `kms-2026a`); with the variable unset a release carries no manifest and the updater has nothing to apply. Details, costs and the threat model: [RELEASING.md](RELEASING.md).

**Launcher.** `current.json` is `{version, previous, knownGood, state, bootCount, trialStarted}`. A freshly staged version runs on **trial**: it is confirmed after the agent's loopback `/healthz` has answered continuously for 60 s, and rolled back automatically (the bad version is denylisted for 7 days) if the agent crashed 3 times within 10 minutes, booted twice without confirming, or is not healthy 120 s after start. Updates exit the agent with code 75 so the launcher restarts into the new version without a crash penalty.

**Opt-outs.** `BOTWARREN_DISABLE_UPDATES=1` (no update traffic at all), `BOTWARREN_DISABLE_AUTOUPDATE=1` (no background checks), `"updates": {"enabled": false}`, `CI=true`, or a machine policy file (`/etc/botwarren/policy.json`, `%ProgramData%\Botwarren\policy.json`) that overrides user config. `BOTWARREN_UPDATE_URL` points at a mirror (same signature chain). Package-manager installs never self-update.

## 5. Connecting, projects and remote settings (0.6)

**Connecting.** `botwarren connect` is the only way in. With a claim token (`BOTWARREN_CLAIM`, made by the website for one ship: single use, 30 minutes) it posts the token once to `/api/claim/exchange` and receives that ship's own secret, which it writes to a file only the user can read. Without a token it runs the device-code flow (a short code approved in the browser; the browser is not opened over SSH or on a machine with no display). The token is never an argument, a file, a service definition or a log line.

**Projects.** Nothing is configured by hand. A session's working folder inside a git checkout is a *project*: its key is `p-` plus 8 hex characters of an HMAC (per-install random salt) over the normalised remote, or the root path when there is no remote, so it is neither reversible nor comparable across installs. The agent tells the owner's website account the key and a display name (repository name, else folder name, restricted to the public display charset). The path stays in `private/discovery.json` (user-only) and is used only to attribute sessions. A project is published only after the owner switches it on in the website; until then sessions in it are not attributed to any public project.

**Remote settings.** The publish response carries the owner's settings. The agent validates and clamps every field: project choices only for keys it discovered itself, a publish delay inside 30 to 120 seconds, and a list of tools to switch off (it can switch a tool off or return it to its configured setting, never enable one that the local config disabled). The website cannot make the agent read anything outside the adapters' declared reads, and cannot run anything.

**Owner report.** On a separate authenticated route (`POST /internal/agent`) the agent reports its computer kind, version, which tools it found and the noticed projects. It is a strict schema with no free text and no path, goes only to the owner's console, and is never part of the public data. `discovery.names: false` replaces repository names with "Project N".

**Disconnect.** If the website revokes the secret the publish endpoint answers 401. After three refusals over at least five minutes the agent stops, deletes its secret file, parks its config and waits to be connected again; a single refusal never wipes anything. `botwarren uninstall` tells the website first, then runs the uninstall script.
