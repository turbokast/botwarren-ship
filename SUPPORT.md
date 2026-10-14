# Getting help

## Questions, ideas and show-and-tell

Use **[GitHub Discussions](https://github.com/turbokast/botwarren-ship/discussions)**. Search first; someone may already have asked. Good places to start:

* *Q&A*: install problems, "how do I...", "what does the agent read when..."
* *Ideas*: a tool you would like supported, a change you would like to see (an adapter request has its own [issue form](https://github.com/turbokast/botwarren-ship/issues/new/choose))
* *Show and tell*: what you built with it

Before asking, these usually answer it:

* [README](README.md): install, verify a release, commands, what the agent reads and sends
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ADAPTERS.md](docs/ADAPTERS.md)
* `botwarren status` and `botwarren adapters explain <id>` on your machine
* The trust page: <https://botwarren.com/trust.html>

## Bugs

Open an [issue](https://github.com/turbokast/botwarren-ship/issues/new/choose) with the bug form: it asks for the agent version (`botwarren --version`), your operating system and how you installed it. **Never paste secrets, tokens, prompts, code, file contents or private paths**; redact them.

## Security and privacy problems

Do **not** open a public issue. If the agent read, logged or sent something it should not have, or you found a weakness in the updater, the installers or the release workflow, follow [SECURITY.md](SECURITY.md): email support@turbokast.com with the subject `SECURITY: botwarren-ship`, or use GitHub's private vulnerability reporting on this repository.

## The hosted Botwarren service and your account

Problems with botwarren.com itself (your ship, sign-in, the public page) are not handled in this repository. Email support@turbokast.com.

## Response times

This is a small project with one maintainer, so there is no service level. Security reports are acknowledged within 3 working days (see [SECURITY.md](SECURITY.md)); questions and issues are usually answered within a week.
