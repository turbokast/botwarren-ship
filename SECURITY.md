# Security policy

The Botwarren ship agent runs on your computer next to your source code and credentials, so its security and privacy properties matter more than its features.

## Reporting a vulnerability

Email **support@turbokast.com** with the subject `SECURITY: botwarren-ship`. Please include what you found, how to reproduce it, the agent version (`botwarren --version`) and your operating system. Do not open a public issue or pull request for a vulnerability, and do not include real secrets or customer data in your report.

You may also use GitHub's **private vulnerability reporting** on this repository ("Security" tab, "Report a vulnerability"): it is enabled, only the maintainer sees the report, and a fix can be prepared in a private fork before disclosure.

## Coordinated disclosure

* We acknowledge a report within **3 working days** and give an initial assessment within **7 days**.
* We work with you on a fix and keep you informed. Confirmed issues are fixed or mitigated as fast as their severity warrants: critical and high severity issues aim for a fixed release within **30 days** of the report, others within **90 days**.
* We ask that you keep the details private until a fixed release is available, or until **90 days** after your report, whichever comes first. If we need longer for a complex fix we will say so and agree a date with you; if you believe users are being actively harmed you may shorten the period, but please tell us first.
* We publish a security advisory with the fix, crediting you if you wish. We are not able to offer a bounty at this time.
* Good-faith research is welcome: test against your own installation, do not access other people's data, do not degrade the hosted Botwarren service, and stop and tell us if you reach someone else's data. We will not pursue action against researchers who follow this policy.

## What counts

Especially welcome (high impact):

* anything that makes the agent read, log or send **content** (prompts, code, command output, file contents, paths, environment values), or that lets a public viewer reach private data
* a bypass of the update trust chain: installing or running anything that is not listed in a validly signed manifest with a matching hash, rolling back to an older manifest, or abusing the installers
* a way for a web page, another local user or a local process to read or control the agent beyond its documented loopback behaviour (DNS rebinding, missing Origin or Host checks, token handling)
* path traversal or unsafe extraction in archive handling, or privilege escalation (the agent and its updater must never need or use elevated rights)
* a way to reach a mutating or content endpoint of an integrated tool (for example a terminal, diff, delete or prompt endpoint) through an adapter
* weaknesses in the release workflow (for example a way to publish or sign an artifact that was not built from a reviewed tag)

Out of scope: vulnerabilities in the third-party tools the agent observes (report those upstream), attacks that need an already compromised user account on the same machine, and denial of service by a local user against their own agent.

## Supported versions

Only the latest release is supported.

## Release integrity

Every release archive is built by the release workflow in this repository, from a `v*` tag, in a protected GitHub environment that needs an approval, and carries a GitHub build attestation. `SHA256SUMS` lists the hashes. Automatic updates are described by an Ed25519-signed manifest whose public key is compiled into the agent; the key is held in Google Cloud KMS and can be used only by the release workflow. Releases since 0.5.0 are published with a signed manifest. Approval of a release is currently by a single maintainer (a deliberate pause, not two-person control). How to verify a release is in the [README](README.md#verify-a-release); the process is in [docs/RELEASING.md](docs/RELEASING.md).

## How this repository is kept safe

* **Automated checks on every change:** CodeQL code scanning (JavaScript, TypeScript and the GitHub Actions workflows), a dependency review on pull requests (known vulnerabilities and a licence allow-list), ESLint, strict TypeScript and tests on Linux, macOS and Windows, `zizmor` and `actionlint` for the workflows, and the OpenSSF Scorecard.
* **Secret scanning with push protection** is on; Dependabot security updates and version updates are on.
* **Workflows** use only actions pinned to a full commit SHA, the narrowest permissions per job, and give pull requests from forks no secret.
* **`main` is protected** by a ruleset (pull requests, required checks, no force pushes, linear history), and `v*` tags cannot be moved or deleted. See [docs/REPO_SETTINGS.md](docs/REPO_SETTINGS.md) for the exact settings and their honest limits (the sole maintainer can bypass the ruleset).
* **Vulnerability disclosure** is described above. Fixed vulnerabilities are published as GitHub security advisories.
