# Changelog

All notable changes to the Botwarren ship agent are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (while the major version is 0, any minor release may change behaviour; releases are marked pre-release on GitHub).

A release is only built from a dated entry in this file: the release workflow takes the section for the tag's version as the body of the GitHub Release and fails if it is missing (see [docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

## [0.9.1] - 2026-10-17

### Fixed

- **A ship could stay offline while the agent kept running.** If one publish to botwarren.com never finished (seen after a short network outage), the agent waited on it forever and sent nothing more until it was restarted, so the ship showed as offline. Each publish now gets a fixed time to finish (10 seconds for the request, 15 at most in total). After that it is given up and the next one goes out. A reply that arrives after it was given up is ignored.

## [0.9.0] - 2026-10-16

Crew bodies that match their model: the agent now reports which family of model each agent runs and how hard it is thinking, never the exact model.

### Added

- **Model family and effort level.** For Claude Code (main sessions and sub-agents), Codex and Ninox, the agent reads the model and reasoning effort from the session's local log on your computer and sends only two coarse values: the maker and model line from a fixed public list (for example "Anthropic / Opus" or "OpenAI / GPT"; anything not on the list is sent as "other"), and an effort level from low to max. Your crew on botwarren.com take that body and show the effort on their chest. The exact model name or version, prompts and settings never leave the computer; a canary test checks that raw model ids are never sent.
- A change of model or effort during a session is picked up and sent again.

### Changed

- Codex sessions no longer report a fixed model; they report what the session's newest turn actually used, or nothing.
- Ninox no longer guesses a model from the agent type; it reports a model only when Ninox does.

## [0.8.0] - 2026-10-15

Code map: an optional, off-by-default view of where in each project your crew is working.

### Added

- **Code map (optional, off by default).** When you switch it on for your ship on botwarren.com, the agent places your crew in the part of each project they are working in, and older parts of the code gather dust and cobwebs on your ship. To do that it reads the file paths of your agents' tool calls (Claude Code) and the git history of your projects **on your computer only**. What leaves the computer is an area number (1 to 9), a coarse kind of code (for example "tests" or "docs"), a "last changed" range and which area each crew member is in. Paths, folder and file names, file counts and dates never leave it. `botwarren codemap` shows the numbers-to-folders mapping locally.

## [0.7.2] - 2026-10-15

OpenCode 2.x support. No change to what the agent sends: still metadata only.

### Added

- The OpenCode adapter reads OpenCode 2.x's local server as well as 1.x: whether each session is working, idle or waiting for you, sub-agent sessions, and the session's folder for attribution (kept on this computer). It uses four read-only routes, checks the server really is OpenCode before trusting the port, and keeps no titles, models, costs, prompts or permission details.
- OpenCode 2.x protects its local server with a password. If you want Botwarren to see it, set `OPENCODE_SERVER_PASSWORD` (and `OPENCODE_SERVER_USERNAME` if you changed it) in the agent's environment. The agent sends it only to a server that has identified itself as OpenCode by its own sign-in challenge, never stores or logs it, and reads nothing from OpenCode's files. Without it, OpenCode 2.x is simply not shown.

## [0.7.1] - 2026-10-15

Makes the optional Botwarren Companion usable from a terminal after the agent installs it. No change to what the agent reads, sends or installs.

### Added

- `botwarren companion pair | devices | pause | resume | confirm | log | claude ... | version` pass through to the installed Companion, so `botwarren companion pair` works on Linux, macOS and Windows without anything on your PATH. Only these subcommands are passed through, only to the component the install gate verified, and never while the computer blocks components. The commands the agent and Claude Code run themselves (`daemon`, `init`, `enroll`, `hook`, `channel`) and `uninstall` (use `botwarren companion remove`, which also forgets the recorded consent) are refused. `botwarren companion status` now also shows the Companion's own status.
- A `botwarren-companion` command next to `botwarren` in the same per-user bin directory the installers use (`~/.local/bin`, or `<install dir>\bin` on Windows; no administrator rights), written when the Companion is installed and removed with it. It is a two-line launcher that runs `botwarren companion <the same arguments>`: it names no version, path or address. It is only written next to an existing `botwarren` command, and a file of that name the agent did not write is never overwritten or removed.

### Changed

- `botwarren uninstall` (macOS and Linux) also removes that launcher.

## [0.7.0] - 2026-10-15

The optional, separate Botwarren Companion (remote approvals) can now be installed by the agent, under a strict gate. The agent's own promise is unchanged: it still reads and sends metadata only, and the Companion is a different program with its own privacy statement.

### Added

- `botwarren companion [status|remove|block|unblock]`: look at the optional Botwarren Companion on this computer, remove it, or refuse it for good. `botwarren companion block` also forgets the recorded consent, and `BOTWARREN_DISABLE_COMPONENTS=1` switches the whole mechanism off.
- **The install gate for the Companion** (`src/component/`). The agent installs exactly one named component, `companion`, and only when all of this holds:
  - you consented on your Botwarren account page (the website's instruction to the agent is two words, `install` or `remove`, and your consent time; it cannot name a URL, a version, a file or a command, and anything more makes the instruction invalid);
  - the component manifest is signed with a Botwarren **component signing key** that is a different key from the one that signs the agent's own updates, and the agent pins the two in **separate sets**: the component installer accepts only component keys and the update verifier accepts only update keys, so neither key's signature is ever accepted for the other's job (a keys document cannot register a component key as an update key either). On top of that, a component manifest has its own signature domain (`botwarren-component-v1`), so a signed agent manifest can never be presented as a component manifest or the other way round. The trust epoch, the anti-rollback counter, expiry and the list of blocked versions apply as for agent updates, and a revocation of the component key by the recovery keys is honoured;
  - the bundle's size and SHA-256 match the signed manifest before the archive is opened, only four allow-listed files (`companion.mjs`, `VERSION`, `LICENSE`, `NOTICE`) are extracted by the path-safe reader, and a self-test passes before anything else runs.
  The manifest address comes from this installation's own configuration (the same downloads host as agent updates), never from the website. An install leaves a log line and a `NOTICE.txt` next to the component; the component is removed by `botwarren companion remove`, by "Turn off" on your account page, or by the account being switched off.
- While the Companion is installed the agent keeps its background process running and reports to your ship's service only the Companion's **public** key (so the service can sign a relay enrolment ticket for it) and whether the install worked (a fixed code and a version). It never sends anything the Companion reads or any device information.

### Changed

- The README explains the optional component and its limits in plain words, documents connecting through the website's one-line command and `botwarren uninstall`, and adds the Companion to the privacy statement (a third kind of network traffic that happens only after your consent, and how to switch it off). The status line now says 0.7.x, and the OpenSSF Best Practices badge (project 15500) is shown.
- `docs/ARCHITECTURE.md` gains a section on connecting, projects, remote settings, the owner report and disconnecting.
- The vendored public contract (`src/vendor/core/`) now also carries the multi-deck ship plan types and the loosely typed `companion` field of the replica settings. These are schema types only: the agent's events and the public projection are unchanged, and nothing new is published.

### Fixed

- The release workflow's publish job now downloads the release notes artifact it uses. The 0.6.0 GitHub Release step failed without it and the release was finished by hand from the run's artifacts.
- Two more byte-order-mark matches (`connect` and `uninstall`) use the explicit escape `\uFEFF` instead of an invisible literal character. Behaviour is unchanged.
- An unused helper in the pairing code was removed.

## [0.6.0] - 2026-10-14

Zero-touch onboarding: install once, and everything else happens on the website.

### Added

- `botwarren connect`: connects this computer to a ship. The personalised command on botwarren.com/get carries a **claim token** (single use, valid for 30 minutes, able to do exactly one thing: claim one ship). The agent exchanges it once for its own ship secret, which goes into a file only you can read. Without a token it falls back to a short device code and opens your browser (or prints the code once on a machine with no desktop or over SSH). The token is passed to the installer through the environment, never written to disk, a service definition or a log.
- Both installers accept the claim token (`BOTWARREN_CLAIM`; `install.sh` also takes `--claim`), validate its shape before downloading anything, run `connect` after the per-user service is registered, and print what happened in plain words. `--no-connect` installs only.
- **Projects are noticed, not configured.** The agent recognises a git checkout from the folder of the coding sessions it already sees. It reports an opaque key and a display name (repository name, else folder name) to your website account only; a local path never leaves the computer. Nothing is published until you switch a project on at botwarren.com, where you can also rename it. `discovery.names: false` reports "Project N" instead of names.
- Settings from the website, validated and clamped by the agent: which noticed projects are shown, publish delay (30 to 120 s), and which tools are switched off. The website can only choose among things the agent itself reported; it cannot make the agent read anything else or run anything.
- A per-computer report to your owner console (computer kind, agent version, which tools were found, noticed projects) over a separate authenticated route; it is never part of the public data.
- `botwarren uninstall`: tells the website, then runs the installed uninstall script (service, command, program files and, unless kept, config and data). `botwarren status` now shows the website link, noticed and shown projects and tool states.
- Disconnect from the website: after sustained refusals (several, over minutes) the agent forgets its secret and idles until it is connected again.
- Code scanning with CodeQL (JavaScript, TypeScript and GitHub Actions workflows), the OpenSSF Scorecard, a dependency review on pull requests (known vulnerabilities and a licence allow-list), and the `zizmor` and `actionlint` linters for the workflow files.
- ESLint (typescript-eslint) aimed at real bugs: floating and misused promises, unused code. Strict `tsc` remains the type gate.
- A V8 coverage report on every CI run (job summary and downloadable artifact).
- A DCO check on pull requests, issue forms, a pull request template, `SUPPORT.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `CITATION.cff`, `.editorconfig` and `.nvmrc`.
- `docs/ADAPTERS.md` (how to write an adapter and the canary rule), `docs/REPO_SETTINGS.md` (the repository settings and branch ruleset, with the reasoning) and `docs/OPENSSF_BEST_PRACTICES.md`.
- A README architecture diagram, the "what it reads and never reads" summary and verification steps for each operating system.

### Changed

- `botwarren pair` and the first run no longer ask for a project folder; `--repo` still adds one by hand. The browser is not opened over SSH or on a Linux machine with no display.
- A session is attributed to a project again as soon as you show or hide it on the website, instead of up to a minute later.
- The `botwarren login` step is no longer needed: an account on botwarren.com owns the ships it creates.
- The GitHub Release body is now taken from this changelog instead of being generated from commit titles.
- Dependabot waits 7 days before proposing a freshly published version and labels its pull requests.
- The release build also runs the linter.
- README: corrected the status of `botwarren pair` (available) and of signed updates (switched on since 0.5.0).

### Fixed

- A byte-order mark in the configuration readers was matched by an invisible literal character; it is now the explicit escape `﻿`. Behaviour is unchanged.
- Errors rethrown while parsing configuration and release manifests now keep their cause.

## [0.5.0] - 2026-10-14

First public release of the agent's source (Apache-2.0).

### Added

- `botwarren pair`: connect a computer to a ship with a one-time code that you approve on botwarren.com, with no secret to copy. The ship secret goes into a file only you can read and is never printed.
- A checksum-verified install mode (`install.sh --checksum-only`, `BOTWARREN_CHECKSUM_ONLY=1` for `install.ps1`) that checks the archive against `SHA256SUMS` over HTTPS and states plainly that automatic updates are then disabled.
- Production update signing: the update manifest is signed with a non-exportable Google Cloud KMS Ed25519 key (`kms-2026a`) that only the release workflow can use. Three offline recovery keys can rotate or revoke it (any 2 of 3); a trust epoch and persisted revocations stop replays.
- A release workflow with a separate no-secrets build, an independent rebuild whose hashes must match, a protected `release` environment that needs a reviewer, GitHub build-provenance attestations, and a signed manifest published last.
- Adapter API v1 and adapters for Claude Code, Codex, Herdr, Ninox, OpenCode and Gemini CLI, each declaring exactly what it reads (`botwarren adapters explain <id>`), and the canary test suite that every adapter must pass.
- The silent, signed and reversible updater with a launcher that runs a new version on trial and rolls back automatically when it is not healthy.
- Server-directed publish cadence (`nextIntervalMs`, `minIntervalMs`), honouring `Retry-After` and backing off on errors.
- Packaging for Linux, macOS and Windows (x64 and arm64) with a pinned, checksum-verified Node.js runtime; reproducible release archives.

### Changed

- The agent is self-contained: the local service, stores, replicator and metadata readers are in this repository, together with a small audited copy of the public event contract (`src/vendor/core/`).

### Fixed

- Windows CI: LF checkouts (`.gitattributes`), named pipes for the Herdr tests, POSIX file-mode assertions only on POSIX, and path comparisons in the pairing tests.

### Security

- The agent reads and sends metadata only (enums, bounded integers and id-like keys). There is no free-text field in the event format, no telemetry, and the updater never runs code that is not listed in a validly signed manifest with a matching SHA-256.

[Unreleased]: https://github.com/turbokast/botwarren-ship/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/turbokast/botwarren-ship/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/turbokast/botwarren-ship/releases/tag/v0.5.0
