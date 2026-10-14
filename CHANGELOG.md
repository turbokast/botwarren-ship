# Changelog

All notable changes to the Botwarren ship agent are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) (while the major version is 0, any minor release may change behaviour; releases are marked pre-release on GitHub).

A release is only built from a dated entry in this file: the release workflow takes the section for the tag's version as the body of the GitHub Release and fails if it is missing (see [docs/RELEASING.md](docs/RELEASING.md)).

## [Unreleased]

### Added

- Code scanning with CodeQL (JavaScript, TypeScript and GitHub Actions workflows), the OpenSSF Scorecard, a dependency review on pull requests (known vulnerabilities and a licence allow-list), and the `zizmor` and `actionlint` linters for the workflow files.
- ESLint (typescript-eslint) aimed at real bugs: floating and misused promises, unused code. Strict `tsc` remains the type gate.
- A V8 coverage report on every CI run (job summary and downloadable artifact).
- A DCO check on pull requests, issue forms, a pull request template, `SUPPORT.md`, `GOVERNANCE.md`, `MAINTAINERS.md`, `CITATION.cff`, `.editorconfig` and `.nvmrc`.
- `docs/ADAPTERS.md` (how to write an adapter and the canary rule), `docs/REPO_SETTINGS.md` (the repository settings and branch ruleset, with the reasoning) and `docs/OPENSSF_BEST_PRACTICES.md`.
- A README architecture diagram, the "what it reads and never reads" summary and verification steps for each operating system.

### Changed

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

[Unreleased]: https://github.com/turbokast/botwarren-ship/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/turbokast/botwarren-ship/releases/tag/v0.5.0
