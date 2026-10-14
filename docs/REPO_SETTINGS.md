# Repository settings

This records how `turbokast/botwarren-ship` is configured on GitHub and why, so the settings can be reviewed and rebuilt. Most of them are not files in the repository, so they are written down here. The state below was applied on 2026-10-14 through the GitHub API (`gh api`) and read back afterwards. If a setting differs from this page, one of them is wrong: fix the setting or send a pull request.

## General

| Setting | Value | Why |
|---|---|---|
| Description | Open-source ship agent for Botwarren: turns what your AI coding agents are doing into a delayed, metadata-only status feed. Never reads or sends prompts, code or paths. | The one-sentence promise |
| Website | <https://botwarren.com/trust.html> | The trust page explains exactly what leaves the computer |
| Topics | `ai-agents`, `ai-coding`, `claude-code`, `cli`, `codex`, `developer-tools`, `nodejs`, `observability`, `open-source`, `privacy`, `telemetry`, `typescript` | Discoverability |
| Issues | on (issue forms, blank issues off) | Bugs, adapter requests, accepted feature work |
| Discussions | on (default categories: Announcements, General, Ideas, Polls, Q&A, Show and tell) | Questions and ideas go here, not in issues ([SUPPORT.md](../SUPPORT.md)) |
| Wiki | off | Documentation lives in the repository, where it is reviewed |
| Projects | off | One maintainer; issues are enough |
| Merge methods | squash only (merge commits and rebase merging off) | Linear history; the squash commit title is the pull request title and the body keeps every commit message, including the `Signed-off-by` lines |
| Automatically delete head branches | on | No stale branches |
| Always suggest updating pull request branches | on | Contributors can bring a branch up to date in one click |
| Allow auto-merge | on | Merge a pull request when the required checks pass |
| Require contributors to sign off on web-based commits | on (was already on) | Web edits carry a DCO sign-off too |

## Security and analysis

| Feature | State | Notes |
|---|---|---|
| Dependency graph | on (public repository) | Needed by the dependency review |
| Dependabot alerts | on | |
| Dependabot security updates | on (was off) | Pull requests for vulnerable dependencies are opened at once, ignoring the 7 day cool-down of version updates |
| Dependabot version updates | on (`.github/dependabot.yml`) | npm and GitHub Actions, weekly, grouped, 7 day cool-down |
| Secret scanning | on | |
| Secret scanning push protection | on | A push that contains a recognised secret is blocked |
| Private vulnerability reporting | on | Security tab, "Report a vulnerability" ([SECURITY.md](../SECURITY.md)) |
| Code scanning | CodeQL by workflow (`.github/workflows/codeql.yml`) | **Not** GitHub's "default setup", which must stay "not configured". See below |
| Scan for generic secrets (non-provider patterns), validity checks | not available | Requesting them through the API is accepted but leaves them disabled: they need GitHub Secret Protection, which is a paid product. Not claimed anywhere |

### Why CodeQL as a workflow and not "default setup"

Default setup is one click and needs no file, but it cannot be reviewed in a pull request, its actions are not pinned to a commit by us, and its query suite and schedule are not in the repository. The workflow is reviewed like code, pinned to a commit SHA, scans the GitHub Actions workflows as well (language `actions`), uses the `security-extended` suite, and runs on pushes to `main`, on pull requests and every Monday. The cost is a file to maintain (Dependabot keeps its pins current).

## Actions

| Setting | Value | Why |
|---|---|---|
| Allowed actions | selected: GitHub-owned actions, plus `pnpm/action-setup`, `google-github-actions/auth`, `signpath/github-action-submit-signing-request`, `ossf/scorecard-action`, `zizmorcore/zizmor-action` and `codecov/codecov-action` | The fewest third parties that the workflows need; "verified creators" are not blanket-allowed |
| Require actions to be pinned to a full commit SHA | on | A tag or branch reference is rejected, so a moved tag cannot change what runs |
| Default workflow token | read-only; workflows may not approve pull requests | Each job asks for what it needs |
| Fork pull request workflows | need approval for first-time contributors | |
| Environment `release` | required reviewer, `v*` tags only; holds the R2 credentials | See [RELEASING.md](RELEASING.md) |
| Variables | `RELEASE_SIGNING`, `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_SERVICE_ACCOUNT` (names of public resources, not secrets) | Signed releases |
| Optional variable | `CODECOV_ENABLED` | Codecov upload (not set) |

## Ruleset `protect-main` (the default branch)

| Rule | |
|---|---|
| Restrict deletions | on |
| Block force pushes (non-fast-forward) | on |
| Require linear history | on |
| Require a pull request before merging | on; **squash** is the only allowed merge method; stale approvals are dismissed on a new push; conversations must be resolved; required approving reviews: **0** (see "The honest limits") |
| Require status checks | `typecheck and test (ubuntu-latest)`, `typecheck and test (macos-latest)`, `typecheck and test (windows-latest)`, `lint`, `Analyze (javascript-typescript)`, `Analyze (actions)`, `dependency-review`, `dco` (branches need not be up to date) |
| Require code scanning results | CodeQL; errors, and security alerts of high severity or higher, block the merge |
| Bypass | the repository **Admin** role (always) |

A second ruleset, `protect-release-tags`, stops `v*` tags being moved or deleted. Only an organisation admin can bypass it.

The `Workflow lint`, `Scorecard` and coverage jobs are deliberately **not** required: the first only runs when workflows change (a skipped required check would block every other pull request), the second is a scheduled report, and coverage is informational.

If a job is renamed in a workflow, update the required check name here and in the ruleset, or merging stops.

### The honest limits

* **There is one maintainer.** GitHub does not let an author approve their own pull request, so requiring one approving review would make the project impossible to maintain alone. The ruleset therefore requires a pull request and green checks, and requires **no** approving review. The moment a second maintainer exists, raise it to 1 and turn on code-owner review (`.github/CODEOWNERS` is already in place). See [GOVERNANCE.md](../GOVERNANCE.md).
* **The admin role can bypass the ruleset**, including pushing straight to `main`. This is on purpose: it keeps the maintainer from being locked out, and it is how the public tree is synchronised from the private development repository. It means these rules protect against mistakes and against everyone else, not against the maintainer's own account. Two-factor authentication is required for the organisation. To make the maintainer go through pull requests too, change the bypass mode from "always" to "for pull requests only".
* The OpenSSF Scorecard will report lower marks for "Code-Review" and "Contributors" for the same reason, and that is accurate.

## Labels

| Label | Colour | Meaning |
|---|---|---|
| `bug` | `d73a4a` | Something isn't working |
| `enhancement` | `a2eeef` | New feature or improvement |
| `documentation` | `0075ca` | Improvements or additions to documentation |
| `security` | `b60205` | Security-hardening work (vulnerabilities are reported privately) |
| `adapter` | `5319e7` | Support for an AI coding tool |
| `good first issue` | `7057ff` | Good for newcomers |
| `help wanted` | `008672` | Extra attention is needed |
| `question` | `d876e3` | Further information is requested (prefer Discussions) |
| `dependencies` | `0366d6` | Pull requests that update a dependency |
| `ci` | `fbca04` | Workflows, tooling and release automation |

GitHub's remaining default labels (`duplicate`, `invalid`, `wontfix`, `accessibility`) and the `javascript` label that Dependabot created are left as they are.

## Owner actions (cannot be done through the API)

These need the repository owner's web login, an account sign-up or an app installation. None of them is needed for the repository to work; each is an improvement.

1. **Social preview image.** Repository Settings, General, "Social preview", Edit, Upload an image: choose `.github/social-preview.png` (1280 x 640). Regenerate it with `scripts/make-shipagent-social-preview.py` in the private repository if the brand changes.
2. **OpenSSF Best Practices badge.** Sign in at <https://www.bestpractices.dev> with GitHub, "Get Your Badge Now", enter `https://github.com/turbokast/botwarren-ship`, and answer the questionnaire using [OPENSSF_BEST_PRACTICES.md](OPENSSF_BEST_PRACTICES.md). Then replace `<ID>` in the commented-out badge in the README and uncomment it.
3. **Codecov (optional).** Sign in at <https://about.codecov.io> with GitHub and add `turbokast/botwarren-ship`. Copy the upload token, then in the repository: Settings, Secrets and variables, Actions, add the secret `CODECOV_TOKEN` and the variable `CODECOV_ENABLED` = `true`. The upload step (`ci.yml`, job `coverage`) runs only on pushes to `main`, so no pull request ever sees the token. Without this, the coverage report is still in every CI run's summary and artifact.
4. **CodeRabbit (optional AI review, free for public repositories).** <https://coderabbit.ai>: sign in with GitHub, install the GitHub App on the `turbokast` organisation for this repository only. It comments on pull requests; it does not block merging. Add a `.coderabbit.yaml` afterwards if the defaults are too chatty.
5. **Socket (optional supply-chain review, free for public repositories).** Install the "Socket Security" GitHub App from <https://github.com/apps/socket-security> for this repository only. It flags risky new dependencies on pull requests.
6. **SonarCloud (optional).** <https://sonarcloud.io>: sign in with GitHub, import the organisation, add this repository (free for public ones). Automatic analysis needs no workflow change; to include test coverage, add a scan step that reads `coverage/lcov.info`.
7. **DCO app (optional).** The `dco` workflow already enforces sign-offs. Install the DCO GitHub App only if you prefer it, and then remove `.github/workflows/dco.yml` and the `dco` required check.
8. **Discussions.** The default categories are in place. Add an "Adapters" category in Discussions, "Manage categories" if you want one (categories cannot be created through the API).
9. **Release notes of 0.5.0.** The existing GitHub Release has only an auto-generated link. After the changelog is published, run `gh release edit v0.5.0 --repo turbokast/botwarren-ship --notes-file <(node scripts/changelog-notes.mjs 0.5.0)` to use the changelog text. Later releases do this by themselves.
10. **Second maintainer.** When there is one: make them the `release` environment reviewer with "prevent self-review" on, require 1 approving review in `protect-main`, and turn on code-owner review.

## Rebuilding these settings

Everything above except the owner actions is `gh api` calls: `PATCH repos/{repo}` (general settings, `security_and_analysis`), `PUT repos/{repo}/topics`, `PUT repos/{repo}/automated-security-fixes`, `PUT repos/{repo}/actions/permissions` and `.../selected-actions`, `PUT repos/{repo}/rulesets/{id}` (the ruleset body is the table above), and `POST`/`PATCH repos/{repo}/labels`. The repository-role id of Admin in a ruleset bypass list is `5`.
