# Governance

This is a small project with one maintainer. This page says honestly how decisions are made, so that contributors know what to expect.

## Who decides

The project is maintained by **TurboKast Ltd**, which owns the Botwarren service this agent reports to. Today the only maintainer is **Liam Humphreys** (see [MAINTAINERS.md](MAINTAINERS.md)). He reviews and merges every change, cuts every release and has the final say. There is no steering committee, no voting and no second approver, and this page does not pretend otherwise: in particular, release approval is by that single person (a deliberate cooling-off step, not two-person control; see [docs/RELEASING.md](docs/RELEASING.md)).

## What does not change

Some decisions are not up for a case-by-case vote because they are the reason the project exists. A change that breaks one of them will be declined, however well it is written:

* the agent reads and sends **metadata only**: enums, bounded integers and id-like keys, never content, paths, prompts or code;
* no telemetry, no analytics, no crash reporting, and no network destination other than the Botwarren service you configured and the download host;
* updates run only if they are listed in a validly signed manifest with a matching hash;
* adapters are read-only and allow-listed, and every adapter has a canary test.

The full list is in [CONTRIBUTING.md](CONTRIBUTING.md#ground-rules).

## How changes are made

1. Open an issue or a [Discussion](https://github.com/turbokast/botwarren-ship/discussions) for anything larger than a small fix, so you do not spend time on something that cannot be merged. Changes to what the agent can publish (the public contract in `src/vendor/core/`) always start with an issue.
2. Send a pull request with tests and a sign-off on every commit ([DCO](CONTRIBUTING.md#licence-and-sign-off-dco)). CI, CodeQL and the dependency review must pass.
3. The maintainer reviews. Expect a first response within a week; this is not a full-time job for anyone. If a pull request goes quiet for a month it may be closed, and can be reopened.
4. Merges are squash merges to `main`, so history stays linear. Releases are tagged from `main` and described in [CHANGELOG.md](CHANGELOG.md).

## Becoming a maintainer

Contributors who have made several substantial, well-tested contributions and who show good judgement about the ground rules above can be invited to review and then to merge. The invitation is the maintainer's decision. Once there is a second maintainer, release approval and changes under `.github/`, `scripts/`, `packaging/` and `src/update/` will need the second person's review, and this page will be updated.

## Continuity

If the maintainer stops working on the project, TurboKast Ltd can name a new one, and because the code is Apache-2.0 anyone may fork it. The release signing key is a non-exportable key in a Google Cloud KMS project (it is on nobody's laptop); the offline recovery keys are currently held by the one maintainer, which is a single point of failure that this page does not hide. The recovery procedure is in [docs/RELEASING.md](docs/RELEASING.md#recovery-rotating-and-revoking-the-release-key).

## Conduct and disagreements

Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md). Reports go to support@turbokast.com. If you disagree with a decision, say so in the issue with your reasons; the maintainer will explain the decision, and may change it.

## Changing this page

Changes to governance are proposed by pull request like any other change and decided by the maintainer, after at least a week of open discussion.
