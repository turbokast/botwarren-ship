# Releasing

This is the maintainers' procedure. It is public so that anyone can see how a release is made and what it does and does not promise.

## What a release contains

For a version `X.Y.Z` the release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) produces:

* `botwarren-X.Y.Z-<target>.tar.gz` (Linux, macOS) or `.zip` (Windows) for `linux-x64 linux-arm64 mac-x64 mac-arm64 win-x64 win-arm64`: the installed layout with a pinned, unmodified official Node.js runtime, the launcher and the agent bundles ([ARCHITECTURE.md](ARCHITECTURE.md#3-packaging))
* `SHA256SUMS` listing the hash of every file above and of the two install scripts
* `install.sh` and `install.ps1`, the one-line installers (copies of `packaging/`)
* GitHub artifact attestations (Sigstore build provenance) for all of them, and the attestation bundle as `attestations-X.Y.Z.sigstore.jsonl`

They are published to the GitHub Release and to Cloudflare R2 (`https://downloads.botwarren.com/`).

**Not included, on purpose, until a production key exists: an update manifest.** The agent's updater and the one-line installers both need a *signed* manifest. Releases therefore have none: the updater has nothing to apply and stays inert, and the installers refuse to install ("no release found" or a missing manifest). People try a release by downloading an archive and verifying it (below). The development key pinned in `src/update/keys.ts` is never used in CI and is refused by default.

## Cutting a release

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test enforces they agree), update the release notes, merge to `main`.
2. Tag the merge commit and push the tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. The workflow refuses a tag that does not match `package.json` or is not on `main`.
3. The `build` job (no secrets, read-only token) typechecks, runs the tests and builds everything. The `reproduce` job rebuilds independently and requires identical `SHA256SUMS`.
4. The `publish` job waits for a reviewer to approve the **`release`** environment. Review the build job's summary (the list of hashes) and the diff of `.github/`, `scripts/` and `packaging/` since the previous tag, then approve. Only then are the artifacts attested, uploaded to R2 and attached to a GitHub Release (marked pre-release while the version is `0.x`).
5. Check the result: `gh attestation verify` on one archive, and fetch `https://downloads.botwarren.com/SHA256SUMS`.

## One-time setup (repository owners)

* GitHub environment **`release`**: required reviewers (at least one person other than whoever pushes the tag, once there is more than one maintainer), deployment branches and tags limited to `v*`, "prevent self-review" on. Environment secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`). The token is scoped to the bucket `botwarren-downloads` with object read and write only. These secrets are stored **only** in this environment, never as repository or organisation secrets.
* Repository settings: tag protection (or a ruleset) for `v*`; `main` protected (reviews, status checks `CI`); Actions allowed to use only GitHub-owned actions and the pinned third-party ones; workflow token default `read`; fork pull request workflows require approval for first-time contributors; private vulnerability reporting on; two-factor authentication required for the organisation.
* Optional environments for the disabled signing stubs: `release-signing-windows` (SignPath) and `release-signing-macos` (Apple), see the comments in `release.yml` for their secrets.

## Verifying a release

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify botwarren-X.Y.Z-linux-x64.tar.gz --repo turbokast/botwarren-ship
```

The attestation says: this file was built by `release.yml` in this repository at that commit. Builds are reproducible: check out the tag and run `node scripts/build-release.mjs --no-manifest --out dist/release` (Node.js 22.18 or newer, pnpm 11; the Node runtimes are verified against `packaging/node-pins.json`); the `SHA256SUMS` you get must equal the published one (signing stages are skipped without credentials, and the published macOS and Windows archives are unsigned until the signing stubs are enabled).

## Updating the pinned Node.js runtime

`packaging/node-pins.json` holds the version and the SHA-256 of every runtime archive. To bump: change the version, run `node scripts/build-release.mjs --update-pins --no-manifest` once with network access, review the new hashes against nodejs.org's `SHASUMS256.txt` for that version, commit the result.

## The production release key (not created yet)

Plan: a non-exportable Ed25519 key in a cloud KMS that only a gated workflow job can use through GitHub's OIDC identity (no key file, no stored credential), plus an offline recovery key set; the public key is then added to `src/update/keys.ts` (replacing the dev key), the workflow gains a `sign` job, and releases start including a signed `manifest.json`, `manifest.json.sig` and `install-index.txt`. Until then everything above applies as written. When this lands, this document and the README are updated in the same change.

## Code signing

Windows: free signing through the [SignPath Foundation](https://signpath.org) is planned (see the code signing policy in the README); the disabled `sign-windows` job is its stub. macOS: Developer ID signing and notarisation need an Apple Developer Program membership; the disabled `notarize-macos` job is its stub. Until they are enabled, Windows and macOS archives are unsigned and the release notes say so. The bundled Node.js runtime binaries carry their publisher's own signatures.
