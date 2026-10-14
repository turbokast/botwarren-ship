# OpenSSF Best Practices: prepared answers

This page prepares the answers to the [OpenSSF Best Practices](https://www.bestpractices.dev) (formerly CII) questionnaire for this project, so the maintainer can register it and copy them across. **Registration is an owner action** (it needs a web login at bestpractices.dev; see [REPO_SETTINGS.md](REPO_SETTINGS.md#owner-actions-cannot-be-done-through-the-api)). Nothing here is a claim of a badge: the badge exists only once the project is registered and the questionnaire is submitted.

Status of each criterion is **Met**, **N/A** (with the reason) or **Unmet** (honestly). "Evidence" is where a reviewer can check. Links are relative to the repository root (`https://github.com/turbokast/botwarren-ship/blob/main/`). Criteria are those of the *passing* level; the form's wording changes over time, so match answers by criterion name. Some answers depend on CI running on GitHub and are marked **(after first CI run)**.

## Basics

| Criterion | Status | Evidence |
|---|---|---|
| Project website succinctly describes what the software does (`description_good`) | Met | [README.md](../README.md), <https://botwarren.com/trust.html> |
| Information on how to obtain, give feedback and contribute (`interact`) | Met | [README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [SUPPORT.md](../SUPPORT.md) |
| Explain how to contribute (`contribution`), requirements for acceptable contributions (`contribution_requirements`) | Met | [CONTRIBUTING.md](../CONTRIBUTING.md) (ground rules, adapter canary rule, DCO), [docs/ADAPTERS.md](ADAPTERS.md), [PR template](../.github/PULL_REQUEST_TEMPLATE.md) |
| FLOSS licence (`floss_license`), OSI-approved (`floss_license_osi`) | Met | Apache-2.0, [LICENSE](../LICENSE), [NOTICE](../NOTICE) |
| Licence in a standard location (`license_location`) | Met | `LICENSE` at the repository root |
| Documentation of basic use (`documentation_basics`) and of the external interface (`documentation_interface`) | Met | [README.md](../README.md) ("Use", configuration), `botwarren --help`, [docs/ARCHITECTURE.md](ARCHITECTURE.md), [docs/ADAPTERS.md](ADAPTERS.md) (the adapter API) |
| Project sites use HTTPS (`sites_https`) | Met | github.com, botwarren.com, downloads.botwarren.com |
| Searchable discussion mechanism (`discussion`) | Met | GitHub Issues and Discussions |
| Documentation in English; accepts bug reports in English (`english`) | Met | |
| Project is maintained (`maintained`) | Met | Active development; see the commit history and [CHANGELOG.md](../CHANGELOG.md) |

## Change control

| Criterion | Status | Evidence |
|---|---|---|
| Public version-controlled source repository (`repo_public`), tracking changes (`repo_track`), interim versions (`repo_interim`), distributed VCS (`repo_distributed`) | Met | <https://github.com/turbokast/botwarren-ship> (git) |
| Unique version per release (`version_unique`), SemVer (`version_semver`) | Met | `package.json` / `src/version.ts` (a test keeps them equal); [CHANGELOG.md](../CHANGELOG.md) says SemVer |
| Releases identified in version control (`version_tags`) | Met | `v*` tags (RELEASING.md says to sign them); the release workflow refuses a tag that does not match `package.json` or is not on `main`. `v*` tags are protected by a ruleset |
| Release notes (`release_notes`), naming fixed vulnerabilities (`release_notes_vulns`) | Met, and N/A | [CHANGELOG.md](../CHANGELOG.md) is the source of every GitHub Release body (`scripts/changelog-notes.mjs`); it has a `Security` heading for fixed vulnerabilities and none have been published yet (N/A until one is) |

## Reporting

| Criterion | Status | Evidence |
|---|---|---|
| Bug reporting process (`report_process`), issue tracker (`report_tracker`) | Met | [Issue forms](../.github/ISSUE_TEMPLATE/), [SUPPORT.md](../SUPPORT.md) |
| Respond to most bug reports in the last 2 to 12 months (`report_responses`), to enhancement requests (`enhancement_responses`) | Met | Answer honestly when you submit: a young project may have few reports. [SUPPORT.md](../SUPPORT.md) states the expected response time |
| Publicly available report archive (`report_archive`) | Met | GitHub Issues and Discussions are public and searchable |
| Vulnerability report process published (`vulnerability_report_process`), private reporting (`vulnerability_report_private`) | Met | [SECURITY.md](../SECURITY.md); GitHub private vulnerability reporting is on; email support@turbokast.com |
| Initial response to a vulnerability report within 14 days (`vulnerability_report_response`) | Met | SECURITY.md commits to 3 working days |

## Quality

| Criterion | Status | Evidence |
|---|---|---|
| Working build system (`build`), common tools (`build_common_tools`), FLOSS build tools (`build_floss_tools`) | Met | Node.js, pnpm, TypeScript, esbuild; `node scripts/build-release.mjs` ([README](../README.md#build-from-source)); builds are reproducible and checked by an independent rebuild in the release workflow |
| Automated test suite (`test`), standard invocation (`test_invocation`) | Met | vitest; `pnpm test` ([CONTRIBUTING.md](../CONTRIBUTING.md#development)) |
| Tests cover most of the code (`test_most`) | Met | V8 coverage is produced by CI (`pnpm coverage`, job summary); 79% of statements and 85% of lines when measured on 2026-10-14. Re-check the number in the latest CI run before submitting |
| Continuous integration (`test_continuous_integration`) | Met | [ci.yml](../.github/workflows/ci.yml): Linux, macOS and Windows on every push and pull request **(after first CI run)** |
| Policy that new functionality gets tests (`test_policy`), evidence of it (`tests_are_added`), documented in the instructions (`tests_documented_added`) | Met | [CONTRIBUTING.md](../CONTRIBUTING.md) ("with tests"; the adapter canary rule), PR template checklist; recent changes add tests alongside code |
| Compiler warnings or linter enabled (`warnings`), addressed (`warnings_fixed`), maximally strict (`warnings_strict`, suggested) | Met | `tsc` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and more ([tsconfig](https://github.com/turbokast/botwarren-ship/blob/main/tsconfig.json)); ESLint with typescript-eslint ([eslint.config.js](../eslint.config.js)); both run in CI and the release build |

## Security

| Criterion | Status | Evidence |
|---|---|---|
| At least one primary developer knows secure design (`know_secure_design`) and common errors (`know_common_errors`) | Met | The design is built around least privilege and a one-way privacy boundary: [docs/ARCHITECTURE.md](ARCHITECTURE.md) (adapter enforcement, update threat model), [SECURITY.md](../SECURITY.md) (what counts). Answer for the maintainer personally when you submit |
| Cryptography: published algorithms, no custom crypto (`crypto_published`, `crypto_call`, `crypto_floss`, `crypto_keylength`, `crypto_working`, `crypto_weaknesses`) | Met | Ed25519 signatures and SHA-256 through `node:crypto`; TLS through Node.js. The agent implements no cryptographic primitive of its own ([`src/update/verify.ts`](../src/update/verify.ts)) |
| Perfect forward secrecy (`crypto_pfs`), secure password storage (`crypto_password_storage`) | N/A | Key agreement is TLS in Node.js, not implemented by the project. The agent stores no user passwords; its ship secret is a random 256-bit token in a file readable only by the user |
| Secure random numbers (`crypto_random`) | Met | Secrets and identifiers use `crypto.randomBytes`; `Math.random` is used only for scheduling jitter |
| Secure delivery against man-in-the-middle (`delivery_mitm`) | Met | HTTPS downloads; archives verified against `SHA256SUMS`, GitHub build attestations and an Ed25519-signed manifest with keys compiled into the agent ([README](../README.md#verify-a-release)) |
| No unsigned hash fetched over unsecured channel (`delivery_unsigned`) | Met | Hashes are fetched over HTTPS only; the default install path verifies a signed manifest |
| Vulnerabilities fixed within 60 days (`vulnerabilities_fixed_60_days`), critical ones fixed quickly (`vulnerabilities_critical_fixed`, suggested) | Met | No known unpatched vulnerabilities; the policy targets 30 days for critical and high ([SECURITY.md](../SECURITY.md)); Dependabot security updates are on |
| No leaked credentials in the repository (`no_leaked_credentials`) | Met | Secret scanning with push protection is on; the public tree is produced by an allow-list export with a leak scan; keys are in Cloud KMS, never in the repository; `.gitignore` excludes key files |

## Analysis

| Criterion | Status | Evidence |
|---|---|---|
| Static code analysis applied (`static_analysis`), for common vulnerabilities (`static_analysis_common_vulnerabilities`, suggested), medium and higher findings fixed (`static_analysis_fixed`), regularly (`static_analysis_often`, suggested) | Met **(after first CI run)** | CodeQL ([codeql.yml](../.github/workflows/codeql.yml), JavaScript, TypeScript and Actions, on every push, pull request and weekly) and ESLint; `zizmor` and `actionlint` on the workflows; strict `tsc` |
| Dynamic analysis (`dynamic_analysis`, suggested), unsafe-language memory checks (`dynamic_analysis_unsafe`), assertions (`dynamic_analysis_enable_assertions`), fix findings (`dynamic_analysis_fixed`) | Unmet, N/A | There is no fuzzing yet. The code is memory-safe (TypeScript on Node.js), so `dynamic_analysis_unsafe` is N/A. A fuzz target for the archive and manifest parsers would be a good first contribution. The integration tests exercise the real loopback sockets and installers |

## Gaps to know about (silver and gold levels)

Be straightforward on the form; these are the honest gaps:

* **Two-person review** (silver and gold) is unmet: there is one maintainer ([GOVERNANCE.md](../GOVERNANCE.md)). Release approval is a deliberate pause by one person, not two-person control.
* **A bus factor of at least two** and **two unassociated significant contributors** (gold) are unmet.
* **Signed commits or tags** are not required; contributions are signed off (DCO), which is not a cryptographic signature.
* **Fuzzing** is not done (see above).
* **Windows files are not code-signed yet**; free signing through the SignPath Foundation is planned (README, "Code signing policy").
* **Hardening / threat model documents** exist as [docs/ARCHITECTURE.md](ARCHITECTURE.md) section 4 and [docs/RELEASING.md](RELEASING.md) (threat model); a separate assurance case is not written.

## Before you submit

1. Merge the changes that add the workflows, and wait for one green CI run, CodeQL run and Scorecard run, so the "after first CI run" answers are true.
2. Check the coverage figure in the latest CI job summary.
3. Register at <https://www.bestpractices.dev>, answer from this page, and submit. Only criteria you are sure about should be marked Met.
4. Put the badge in the README (the commented line at the top) with your project number.
