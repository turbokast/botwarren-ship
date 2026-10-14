# Botwarren ship agent

[![CI](https://github.com/turbokast/botwarren-ship/actions/workflows/ci.yml/badge.svg)](https://github.com/turbokast/botwarren-ship/actions/workflows/ci.yml)
[![Licence: Apache-2.0](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

The ship agent runs on your own computer and turns what your AI coding agents are doing (Claude Code, Codex, Herdr, Ninox, OpenCode, Gemini CLI, ...) into a small, delayed, **metadata-only** status feed for your [Botwarren](https://botwarren.com) ship: who is working, who is waiting for you, how full a context window is, whether a build passed. It never reads or sends your prompts, code, command output, file contents or file paths.

This repository is the whole agent. The Botwarren website, hosted service and artwork are separate and not part of it. Everything the agent reads, keeps and sends is in this repository, so you can check it.

> Status: pre-release (0.5.x). Pairing a computer with a ship is not in this version yet (see [Use](#use)). Releases are not yet signed for automatic updates: installs are checksum-verified and update by re-running the installer (see [Install](#install) and [Verify a release](#verify-a-release)).

## What it reads and what it sends

**Reads (locally, read-only):** file names and timestamps, and a few numeric or enum fields, of the session logs and local APIs of the tools you use. Each adapter declares exactly what it reads; run `botwarren adapters explain <id>` to see it.

**Sends (only to the Botwarren service you configured, delayed 30 to 120 seconds):** enum-only events: a pseudonymous worker id, a state (`working`, `idle`, `waiting_for_human`, `left`), the tool family, a coarse context-fill bucket (`low`, `mid`, `high`, `full`), build and deploy states, a project that you approved, and coarsened timestamps. There is no free-text field in the event format.

**Never sent:** prompts, replies, code, diffs, command lines or output, file contents, folder or file paths, repository names (unless you opt in to publishing real project names), environment values, tokens.

The full explanation, with the exact list of events and the checks that enforce it, is on the trust page: **<https://botwarren.com/trust.html>**. How it is enforced, in code you can read:

* **Adapters cannot leak by construction.** An adapter may only emit closed enums, bounded integers and id-like keys (`src/adapters/api.ts`). Text that exists on your machine (a project folder) stays in a private local journal and is never part of an event.
* **Read-only, allow-listed access.** Local HTTP is GET-only on `127.0.0.1` with an exact path allow-list; Herdr is only asked `agent.list` and `ping`; file reads are confined to declared folders and never follow symlinks.
* **A canary test guards every adapter.** `test/adapters/canary.test.ts` plants secret strings in prompts, tool output, titles, environment values and folder names and fails if one reaches any event, public projection or log line.
* **One-way boundary.** The public view is derived by an allow-listed projection (`projectPublic` in `src/vendor/core/projection.ts`). Nothing is "sanitised" afterwards, and the delay is not a privacy filter.
* **Local only otherwise.** The private journal and a loopback-only "ops room" (a page on `127.0.0.1`, protected by a token) stay on your machine. `botwarren pause` stops all publishing at once.

## Install

Releases are published on the [Releases page](https://github.com/turbokast/botwarren-ship/releases) and at `https://downloads.botwarren.com/`, with a `SHA256SUMS` file and GitHub build attestations (see [Verify a release](#verify-a-release)).

The one-line installers are per user (no administrator rights). They download a pinned official Node.js runtime together with the agent, install under `~/.local/share/botwarren` or `%LOCALAPPDATA%\Botwarren`, add a `botwarren` command and register a per-user background service. They have two ways to decide that the download is the real one:

| | Signed manifest (preferred) | Checksum only (what exists today) |
|---|---|---|
| How | The archive's hash must be in a release manifest signed with the Ed25519 release key that is compiled into the agent. | The archive's hash must match `https://downloads.botwarren.com/<version>/SHA256SUMS`, fetched over HTTPS. |
| Needs | A published, signed manifest. The production release key exists; releases carry a manifest once signed mode is switched on ([docs/RELEASING.md](docs/RELEASING.md)). Release approval is currently by a single maintainer. | Nothing but the release. You ask for it explicitly. |
| Protects against | A compromised download host or a man in the middle. | A corrupted or tampered download in transit (TLS) and mix-ups between files. **Not** a compromised download host: someone who controls it could change the archive and its checksum together. |
| Auto-update | On, silent, signed, reversible. | **Disabled** for this install until a signed manifest exists. The updater never runs unsigned code. |

Without `--checksum-only` the installers use the signed path, and if the release has no signed manifest they stop and tell you so; they never quietly fall back.

```sh
# macOS and Linux: signed manifest (stops with a clear message while no manifest is published)
curl -fsSL https://downloads.botwarren.com/install.sh | sh

# macOS and Linux: checksum-verified, a version you name (or the newest from latest.txt if you leave out --version)
curl -fsSL https://downloads.botwarren.com/install.sh | sh -s -- --checksum-only --version 0.5.0
```

```powershell
# Windows 10 and 11: signed manifest
irm https://downloads.botwarren.com/install.ps1 | iex

# Windows: checksum-verified (options are environment variables so they also work under iex)
$env:BOTWARREN_CHECKSUM_ONLY = '1'; $env:BOTWARREN_VERSION = '0.5.0'; irm https://downloads.botwarren.com/install.ps1 | iex
```

Checksum mode in detail: it resolves the version (`--version X.Y.Z`, or the one line in `https://downloads.botwarren.com/latest.txt`), downloads `<version>/SHA256SUMS`, requires the archive for your system to be listed there, downloads the archive, compares its SHA-256, lists it and refuses unsafe paths, and only then installs. It prints that auto-update is disabled for the install and records `"verification": "sha256sums"` in the install receipt. `latest.txt` and `SHA256SUMS` are plain files with the same trust as the host, which is why the table above is honest about what this mode does not cover.

**Trust trade-off, in one sentence:** the archive is verified over HTTPS against the published checksums; you can also verify it against the GitHub Release and its build-provenance attestation, which does not depend on the download host (see [Verify a release](#verify-a-release)). To do that before installing, fetch the archive and `SHA256SUMS` yourself, verify them there, and use the manual route below.

Prefer to read first: both scripts are in [`packaging/`](packaging/) (`install.sh --help` lists every option).

### Manual install of a release archive

1. Download the archive for your system from the Releases page, plus `SHA256SUMS`.
2. Verify it (next section).
3. Unpack it into the install directory (the archive is exactly the installed layout) and start it:

```sh
mkdir -p ~/.local/share/botwarren
tar -xzf botwarren-<version>-linux-x64.tar.gz -C ~/.local/share/botwarren
export BOTWARREN_HOME=~/.local/share/botwarren
"$BOTWARREN_HOME/runtime/node/node" "$BOTWARREN_HOME/launcher/launcher.mjs" cli --version
```

(Windows: unpack the `.zip` to `%LOCALAPPDATA%\Botwarren`.) A background service is not registered by this route; the installers do that part.

Remove everything an installer put on your machine with `botwarren uninstall` (add `--keep-config` to keep your settings).

## Use

```
botwarren status                     is the agent running; what is it publishing
botwarren adapters [explain <id>]    which tools it can see, and exactly what each reads
botwarren run -- <build command>     report a build or test run as CI activity (the command text is never sent)
botwarren pause | resume             emergency stop and resume of publishing
botwarren ops                        where your private local ops room is
botwarren login                      sign in to botwarren.com as the owner of your ship
botwarren update [status]            updates (see below)
botwarren pair                       connect this computer to your ship   (not available yet)
```

`botwarren pair` will connect a computer to a ship with a one-time code; it does not exist in 0.5.0. Today the ship configuration file and ship secret are created by hand (or by the installer): see [`src/config.ts`](src/config.ts) for the schema (`config.json` in `~/.config/botwarren-ship/` or `%APPDATA%\Botwarren\`). The secret is kept in a separate file that only you can read.

### Tools it can see

| Adapter | How | Notes |
|---|---|---|
| Claude Code | session log metadata | sub-agents, tool errors, steps, context fill |
| Codex | rollout file headers | pairs with a Claude session of the same project |
| Herdr | local socket, `agent.list` only | named sessions supported |
| Ninox | `127.0.0.1` read-only API | macOS and Linux; merged with the Claude session it runs |
| OpenCode | its local server | documented shapes; unverified against a live install |
| Gemini CLI | file names only | unverified against a live install |

Configure in `config.json`: `"adapters": { "ninox": { "enabled": true, "port": 8081 } }`. To add a tool, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Updates

Automatic updates are designed to be silent, signed and reversible: a release is described by a manifest signed with an Ed25519 key whose public half is compiled into the agent; the agent refuses anything not listed in it with a matching SHA-256, refuses older manifests, and runs a new version on trial and rolls back if it is unhealthy. **Until a production release key exists no manifest is published, so the updater has nothing to fetch and stays inert, and an install made with `--checksum-only` is not updated automatically** (re-run the installer to move to a newer version; once signed manifests exist the same install starts receiving signed updates, because the agent verifies them itself). The only dev public key compiled in is refused unless you set `BOTWARREN_UPDATE_ALLOW_DEV_KEY=1`.

An update check is two static file downloads from `https://downloads.botwarren.com/` and sends only the HTTP request itself (with a `botwarren-agent/<version>` user agent). There is no telemetry. Turn it off: `BOTWARREN_DISABLE_AUTOUPDATE=1` (manual `botwarren update` still works), `BOTWARREN_DISABLE_UPDATES=1` (no update traffic at all), or `"updates": { "enabled": false }` in `config.json`. Installs made by a package manager never self-update.

## Verify a release

Every release archive is built by [`release.yml`](.github/workflows/release.yml) from a tagged commit, in a protected environment that needs a reviewer's approval, and is attested with GitHub artifact attestations (Sigstore build provenance). Check what you downloaded:

```sh
sha256sum --check --ignore-missing SHA256SUMS          # macOS: shasum -a 256 -c SHA256SUMS
gh attestation verify botwarren-<version>-linux-x64.tar.gz --repo turbokast/botwarren-ship
```

The checksum list can come from `https://downloads.botwarren.com/<version>/SHA256SUMS` or from the GitHub Release; compare the two (they must be identical). Only the attestation is independent of the download host, so for a stricter check pin what it must say:

```sh
gh attestation verify botwarren-<version>-linux-x64.tar.gz --repo turbokast/botwarren-ship \
  --signer-workflow turbokast/botwarren-ship/.github/workflows/release.yml --source-ref refs/tags/v<version>
# offline, from the attestation bundle attached to the Release (the file attestations-<version>.sigstore.jsonl):
gh attestation verify botwarren-<version>-linux-x64.tar.gz --repo turbokast/botwarren-ship --bundle attestations-<version>.sigstore.jsonl
```

(Needs the GitHub CLI; the first form asks GitHub's API for the attestations of the file's SHA-256, so run `gh auth login` first. On Windows, `Get-FileHash <file> -Algorithm SHA256` gives the hash to compare with `SHA256SUMS`.)

The attestation proves the file was produced by that workflow in this repository at that commit. Reproducible builds (fixed timestamps, sorted entries) let you rebuild and compare hashes: see [Build from source](#build-from-source) and [docs/RELEASING.md](docs/RELEASING.md).

## Build from source

Requires Node.js 22.18 or newer and [pnpm](https://pnpm.io) 11.

```sh
pnpm install
pnpm typecheck
pnpm test
node scripts/build-release.mjs --no-manifest                  # full archives (add --offline to use only the cached, hash-pinned Node runtimes)
```

The release build downloads the pinned Node.js runtime once (checked against both nodejs.org's `SHASUMS256.txt` and the hash committed in `packaging/node-pins.json`) and caches it in `.cache/node`. Tests need no network. The architecture, the adapter contract, packaging and the update model are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

`src/vendor/core/` holds the small, audited public contract (the event schema, the local reducer, and the one-way projection into the public schema), copied from the Botwarren core package at export time. It is part of this project and licensed like it.

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org). (Windows release files will be signed with it once the project is accepted by the SignPath Foundation; until then Windows files are unsigned and the release notes say so.)

**Team roles.** All three roles for this project are currently held by one person:

| Role | Member |
|---|---|
| Committers and reviewers | Liam Humphreys (TurboKast Ltd) |
| Approvers (approve every signing request) | Liam Humphreys |

Every signing request is made by the release workflow from a tagged commit of this repository, in a protected GitHub environment, and has to be approved by an approver before a file is signed. Only artifacts built by that workflow from this repository's source are signed; no binaries of other projects are signed. The bundled Node.js runtime is the unmodified official build, already signed by its publisher.

**Privacy.** This program does not transfer information to other networked systems except as follows, and only because you installed and configured it to: (1) it sends the metadata-only, delayed status feed described above to the Botwarren service of the ship you configured (by default `botwarren.com`), and `botwarren login` contacts that same service; (2) it checks for updates by downloading static files from `downloads.botwarren.com`, which receives the request itself and nothing else. It does not send source code, prompts, file contents or paths, and it contains no analytics or crash reporting. Both transfers can be switched off (`botwarren pause`, or do not configure a ship; `BOTWARREN_DISABLE_UPDATES=1`). Details: <https://botwarren.com/trust.html>.

## Security

Report vulnerabilities to **support@turbokast.com** (see [SECURITY.md](SECURITY.md)). Please do not open public issues for them.

## Contributing

Contributions are welcome under the Apache-2.0 licence with a DCO sign-off: see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

## Licence

Apache License 2.0, Copyright 2026 TurboKast Ltd. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Botwarren and TurboKast are names of TurboKast Ltd; the licence does not grant rights to use them beyond describing the origin of the software.
