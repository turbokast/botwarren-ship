# Releasing

This is the maintainers' procedure. It is public so that anyone can see how a release is made and what it does and does not promise.

## What a release contains

For a version `X.Y.Z` the release workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) produces:

* `botwarren-X.Y.Z-<target>.tar.gz` (Linux, macOS) or `.zip` (Windows) for `linux-x64 linux-arm64 mac-x64 mac-arm64 win-x64 win-arm64`: the installed layout with a pinned, unmodified official Node.js runtime, the launcher and the agent bundles ([ARCHITECTURE.md](ARCHITECTURE.md#3-packaging))
* `SHA256SUMS` listing the hash of every file above and of the two install scripts
* `install.sh` and `install.ps1`, the one-line installers (copies of `packaging/`)
* `bundle-X.Y.Z.zip`, the platform-independent app bundle the silent updater installs
* GitHub artifact attestations (Sigstore build provenance) for all of them, and the attestation bundle as `attestations-X.Y.Z.sigstore.jsonl`
* in **signed mode** (below): `manifest.json`, `manifest.json.sig` (Ed25519, Google Cloud KMS) and `install-index.txt`, with their own attestation

They are published to the GitHub Release and to Cloudflare R2 (`https://downloads.botwarren.com/`). Layout of the bucket: `<version>/` holds every file of that release (archives, `SHA256SUMS`, `install.sh`, `install.ps1`), immutable; the bucket root holds flat copies of the archives and `SHA256SUMS-<version>` (what the signed-manifest installers and the updater read once a manifest exists), the current `SHA256SUMS`, `install.sh`, `install.ps1`, and `latest.txt` (one line: the newest version, uploaded last).

### Two modes

The repository variable `RELEASE_SIGNING` chooses (Settings, Secrets and variables, Variables):

* **Signed mode** (`RELEASE_SIGNING=kms`): the `sign-manifest` job signs an update manifest with the production release key (next sections). The release also publishes `manifest.json`, `manifest.json.sig` and `install-index.txt` to the bucket root, **manifest last**. The agent's updater and the one-line installers use it; the installer verifies it with `botwarren verify-release` against the keys compiled into the agent.
* **Checksum mode** (variable unset, the state until the owner switches it on): no manifest. The updater stays inert and `install.sh` / `install.ps1` without options stop with "this release has no signed update manifest yet". The installers keep their explicit **checksum-verified mode** (`install.sh --checksum-only [--version X.Y.Z]`, `BOTWARREN_CHECKSUM_ONLY=1` for `install.ps1`): it downloads `<version>/SHA256SUMS` over HTTPS, verifies the archive against it, refuses unsafe archive paths, installs, and says that auto-update is disabled for the install. It is weaker than a signed manifest (a compromised download host could change an archive and its checksum together), which is why it is opt-in and why people who want more compare against the GitHub Release and the build-provenance attestation (`gh attestation verify`). It keeps working in signed mode too, and an install made with it begins receiving signed updates by itself once a signed manifest exists (the agent verifies manifests with its pinned keys, whatever the installer used).

The development key pinned in `src/update/keys.ts` (`dev-1`) is never used in CI and is refused by the agent unless `BOTWARREN_UPDATE_ALLOW_DEV_KEY=1`.

## Cutting a release

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test enforces they agree), update the release notes, merge to `main`.
2. Tag the merge commit and push the tag: `git tag -s vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`. The workflow refuses a tag that does not match `package.json` or is not on `main`.
3. The `build` job (no secrets, read-only token) typechecks, runs the tests and builds everything (`--no-manifest --emit-bundle`). The `reproduce` job rebuilds independently and requires identical `SHA256SUMS`.
4. Signed mode: the `sign-manifest` job waits for approval of the **`release`** environment. Review the build job's summary (the list of hashes) and the diff of `.github/`, `scripts/`, `packaging/` and `src/update/` since the previous tag, then approve. The job assembles the manifest from the downloaded, hash-checked files (it rebuilds nothing; the previous manifest is fetched from the bucket and used only after it verifies against the pinned keys), signs it with Cloud KMS, checks the signature against the **pinned** public key and with the agent's own verifier, and keeps the three files as an artifact. If it fails, nothing is published.
5. The `publish` job waits for the **`release`** environment again (a second approval, because it is a separate job). Only then are the artifacts attested, uploaded to R2 (archives, checksums, installers, then the bundle, `install-index.txt`, `manifest.json.sig`, `manifest.json`, and `latest.txt` last) and attached to a GitHub Release (marked pre-release while the version is `0.x`).
6. Check the result: `gh attestation verify` on one archive, fetch `https://downloads.botwarren.com/<version>/SHA256SUMS` and `latest.txt`, run `install.sh --checksum-only --version <version>` in a throwaway account or container and, in signed mode, `install.sh --version <version>` and `botwarren update status`. In the Google Cloud console (Logging, `cloudkms.googleapis.com` AsymmetricSign) there must be exactly one signing entry for this run, from `release-signer@botwarren-release.iam.gserviceaccount.com`, and one alert e-mail.
7. Manifests expire after 30 days (the updater then does nothing and never stops a running agent): publish a release, or sign a fresh manifest with the emergency procedure below, within 30 days.

## One-time setup (repository owners)

* GitHub environment **`release`**: required reviewers, deployment branches and tags limited to `v*`. **Today there is one maintainer, so the reviewer is the same person who pushes the tag: this gate is a deliberate cooling-off step (a pause to look at the hashes and the diff, with a wait timer if wanted), not two-person control, and nothing public may claim two-person release.** Once there is a second maintainer, make them the reviewer and turn "prevent self-review" on; that is a settings change and needs no code change. Environment secrets: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT` (`https://<account id>.r2.cloudflarestorage.com`). The token is scoped to the bucket `botwarren-downloads` with object read and write only. These secrets are stored **only** in this environment, never as repository or organisation secrets.
* Repository settings: tag protection (or a ruleset) for `v*`; `main` protected (reviews, status checks `CI`); Actions allowed to use only GitHub-owned actions and the pinned third-party ones; workflow token default `read`; fork pull request workflows require approval for first-time contributors; private vulnerability reporting on; two-factor authentication required for the organisation.
* Repository **variables** for signed mode (public names, not secrets): `RELEASE_SIGNING=kms`, `GCP_WORKLOAD_IDENTITY_PROVIDER=projects/881108236417/locations/global/workloadIdentityPools/github-release/providers/botwarren-ship`, `GCP_SERVICE_ACCOUNT=release-signer@botwarren-release.iam.gserviceaccount.com`, optional `RELEASE_EPOCH` (default 1, see "Recovery").
* Optional environments for the disabled signing stubs: `release-signing-windows` (SignPath) and `release-signing-macos` (Apple), see the comments in `release.yml` for their secrets.

## Verifying a release

```sh
sha256sum --check --ignore-missing SHA256SUMS
gh attestation verify botwarren-X.Y.Z-linux-x64.tar.gz --repo turbokast/botwarren-ship
```

The attestation says: this file was built by `release.yml` in this repository at that commit. Builds are reproducible: check out the tag and run `node scripts/build-release.mjs --no-manifest --emit-bundle --out dist/release` (Node.js 22.18 or newer, pnpm 11; the Node runtimes are verified against `packaging/node-pins.json`); the `SHA256SUMS` you get must equal the published one (signing stages are skipped without credentials, and the published macOS and Windows archives are unsigned until the signing stubs are enabled).

## Updating the pinned Node.js runtime

`packaging/node-pins.json` holds the version and the SHA-256 of every runtime archive. To bump: change the version, run `node scripts/build-release.mjs --update-pins --no-manifest` once with network access, review the new hashes against nodejs.org's `SHASUMS256.txt` for that version, commit the result.

## The production release key

**What it is.** `kms-2026a`: a non-exportable Ed25519 key in Google Cloud KMS (`EC_SIGN_ED25519`, protection level SOFTWARE), project `botwarren-release` (number 881108236417), key ring `botwarren-release` in `europe-west2`, key `manifest-signing`, version 1. Nobody, including the owner, can read or copy the private half. Its public key is pinned in `src/update/keys.ts`:

```
kms-2026a   MCowBQYDK2VwAyEA9wgEUj5KLXm+KZSD9cpJw3B8KmTtGDGL4gudKWPfTuM=
```

Check it any time: `node scripts/release-sign.mjs --kms projects/botwarren-release/locations/europe-west2/keyRings/botwarren-release/cryptoKeys/manifest-signing/cryptoKeyVersions/1 --print-public-key` (needs a Google account allowed to read it).

**Why software, and the cost.** Software protection meets the plan: the key lives only inside Google's KMS service and cannot be exported either way. HSM protection costs more and adds nothing for this threat model, where the realistic attacks are on who may *use* the key, not on extracting it. List price is about USD 0.06 per key version per month plus USD 0.03 per 10,000 operations (from the published price list, to be re-checked on the bill): one release a week is far below USD 1 a month in total. A budget alert is recommended (owner action below).

**Algorithm and the size limit.** Cloud KMS signs with plain Ed25519 (PureEdDSA over the data you send), so signatures verify with the agent's `node:crypto` unchanged and the key is "just another entry" in the pinned list. The limit for one signing call is 64 KiB of data (measured with `gcloud kms asymmetric-sign`: 65,536 bytes accepted, 65,537 refused). The signed message is a 22-byte domain prefix plus `manifest.json`, so the build and the signer refuse a manifest over 64,000 bytes, and `assemble-manifest.mjs` keeps the newest 25 releases in it (`--keep-releases`). A SHA-512 prehash was not needed.

**Who can use it.** Only the service account `release-signer@botwarren-release.iam.gserviceaccount.com`: it has `roles/cloudkms.signerVerifier` on that one key and no other role, no JSON key exists for it (user-managed keys: none), and it can be impersonated only through the workload identity pool `github-release`, provider `botwarren-ship`, which accepts a GitHub OIDC token only when **all** of this holds: repository id `1419280079` (turbokast/botwarren-ship; the numeric id, so a deleted and re-created repository of the same name is a different identity), owner id `335585049`, the workflow `turbokast/botwarren-ship/.github/workflows/release.yml` at a `refs/tags/v*` tag, and environment `release`. Pull requests, forks, branches, other workflows and other repositories are refused by Google. Anyone who is a **project owner** of `botwarren-release` can still use the key from their own machine with their own Google login: that is not prevented, it is detected (next paragraph).

**Detection.** Cloud Audit Logs for Cloud KMS have Admin Read, Data Read and Data Write switched on, and an alert policy ("Botwarren release key: signing call", a log-match policy) e-mails the owner on every `AsymmetricSign` on this key (Google rate-limits one policy to one e-mail per five minutes). Expect exactly one e-mail per release, matching a release run. **An e-mail with no release run in progress means the key was used by someone else: treat it as a compromise.**

**Kill switch.** Stop all signing at once: `gcloud kms keys versions disable 1 --key manifest-signing --keyring botwarren-release --location europe-west2 --project botwarren-release` (and optionally disable the provider: `gcloud iam workload-identity-pools providers update-oidc botwarren-ship --location global --workload-identity-pool github-release --disabled`). Re-enable with `enable`. No secret exists to rotate. Then follow "Recovery" to revoke the key id for already-deployed agents.

**Emergency signing by the owner** (for example a fresh manifest when CI is unavailable): build or fetch the unsigned manifest, then `gcloud auth login` as the project owner and run `node scripts/release-sign.mjs --kms <resource above> --key-id kms-2026a manifest.json`, upload `manifest.json.sig` then `manifest.json`. The alert e-mail will arrive, which is expected. `--epoch` and `--manifest-version` of `build-release.mjs` / `assemble-manifest.mjs` set the manifest's epoch and counter.

## Recovery: rotating and revoking the release key

Three **recovery keys** (`recovery-1`, `recovery-2`, `recovery-3`, offline Ed25519 keys; public keys pinned in `src/update/keys.ts`) never sign releases. **Any two** of them sign a small **keys document** (`keys.json` with `keys.json.sig`) that tells every agent: which additional release keys to trust, which key ids are revoked (permanently), and the trust **epoch**. One recovery key alone is worthless, and two stolen ones are needed to harm anyone.

```
recovery-1  MCowBQYDK2VwAyEAgh+PRhJvAXPllKqUBsQTCZsJoycIr7hluvOsE4/7qDE=
recovery-2  MCowBQYDK2VwAyEATvR3zU+ComOHom/14gbi9EgVvEyEcv8WPjf9X8MG4jE=
recovery-3  MCowBQYDK2VwAyEA0o4UlhviMcetJCdw8gpRjnjinf40H10lPNDwlyKgczY=
```

How the agent treats them (all covered by `test/update/trust.test.ts`): a manifest signed by a recovery key is refused; a keys document needs two **distinct** pinned recovery signatures (the same key twice, a release key, an unknown key or a signature made for another purpose does not count); its `seq` must exceed the one the agent already holds (a replayed older document is ignored) and its `epoch` can never go down; it cannot redefine a pinned key id, add a recovery key or revoke a recovery key; the result is stored in `state/trust.json`, so a revoked key id stays refused after restarts even if someone replays an old signature made by it; a manifest must carry the trusted epoch (older: refused, newer: refused, only a keys document raises it); a release key can raise `manifestVersion` by at most 1000 over the highest accepted one, and an epoch bump resets that counter, which is how a "freeze" (a compromised key signing a huge version) is recovered.

**Rotate or revoke** (the owner has the three encrypted files; see "Custody"):

1. Create or choose the new release key (for example a new KMS key version, and pin its public key under a new id), then write the document: `node scripts/release-sign.mjs --keys-doc-new --seq <n> --epoch <e> --add <new-id>=<spki> --revoke kms-2026a --out keys.json` (`seq` one higher than the last published, `epoch` unchanged for a routine rotation, one higher for an emergency).
2. Two holders each decrypt their key to a 0600 file outside the repository (`age -d recovery-1.age > /dev/shm/r1.pem`, passphrase from their own storage) and run `node scripts/release-sign.mjs --keys-doc-sign --keys keys.json --recovery-key /dev/shm/r1.pem --recovery-id recovery-1 --out keys.json.recovery-1` (the script refuses a key that does not match the pinned public key), then delete the decrypted file. Combine: `node scripts/release-sign.mjs --keys-doc-combine --keys keys.json --out keys.json.sig keys.json.recovery-1 keys.json.recovery-3` (it enforces the threshold).
3. Upload `keys.json` and `keys.json.sig` to the bucket root. Agents fetch them at their next check and the installers fetch them too. If the epoch was raised, set the repository variable `RELEASE_EPOCH` to the new value so the next release uses it, and in an emergency also kill-switch the old key version first.

The recovery key **set** itself is compiled into the agent, so replacing a recovery key needs a new agent release.

## Custody of the recovery keys (owner)

Generated on the owner's machine on 2026-10-14 by `scripts/recovery-keygen.mjs` in the private repository (not part of this tree): each private key is encrypted in the standard [age](https://age-encryption.org) format with its **own random passphrase** (so any plain `age -d` can open it years from now, with no Botwarren code), written as `recovery-N.age` with `recovery-N.passphrase` beside it, mode 0600, under `~/.config/botwarren/recovery/` on that machine, and never printed or committed. Passphrase encryption was chosen over encrypting to the owner's backup key so that a leak of the backup key does not unlock the recovery set and the recovery set does not depend on the backup key surviving. The owner moves each pair (the `.age` file and its passphrase) to its own place: (1) the password manager, (2) an offline USB drive kept apart, (3) a printed copy in a safe, then deletes the files from the machine. The honest limit: whoever gets one place gets one key, and two places are needed to act; the passphrase only protects the copy lying on a laptop or drive, it is not a second factor between a place and its own key.

## Threat model (summary, honest)

| Threat | What stops it | What does not |
|---|---|---|
| Stolen laptop | The release key is not on any machine. A stolen recovery key is useless alone | A laptop holding two recovery keys and the owner's Google session |
| Compromised CI (poisoned dependency, action, runner) | The build job has no secrets and no id-token; the sign job runs only the SHA-pinned Google auth action and installs one dependency without install scripts; the build is reproduced independently before signing; every action is pinned to a commit; every signing call is logged and e-mailed | An approved release whose build was already malicious is signed. Mitigations: the reproducible build, the diff review at approval |
| Malicious or mistaken maintainer | Google refuses any use outside the tagged workflow and environment; tag and branch rules; audit log | **A solo owner can approve their own release and use the key as project owner. With one maintainer the environment gate is a cooling-off pause, not a second pair of eyes.** The alert e-mail and the kill switch are the controls |
| Compromised download host, DNS or CDN | The agent verifies the signature against compiled-in keys before parsing, then size and sha256 of every artifact; epoch and version counters stop replays; expiry bounds a freeze | Withholding updates until the manifest expires (30 days); the first install trusts TLS to the download host for the installer script (the same as every `curl | sh` installer) |
| Compromised Google Cloud project | The key cannot be copied; the alert fires on use; the kill switch; recovery keys revoke it | An owner-level account can use the key until noticed |
| Loss of the release key or one recovery key | KMS keys are durable; any two of three recovery keys suffice | Loss of two recovery keys needs a new agent release with new pinned recovery keys |

## Owner actions still open

1. Move the three recovery key pairs to three separate places and delete the local copies (see "Custody").
2. In `turbokast/botwarren-ship`: create the `release` environment (reviewer, `v*` tags only, optional wait timer), set the four repository variables above, protect `v*` tags. Do not set `RELEASE_SIGNING` until the environment exists: without it the workflow stays in checksum mode.
3. Confirm the alert: a test signing was made on 2026-10-14 (the fixture in `test/update/kms-fixture.ts`); an e-mail "Botwarren release key: signing call" should have arrived. If not, open Monitoring, Alerting, Notification channels and check the channel (created through the API; the console may ask to verify it).
4. In Google Cloud (needs roles this setup did not have): enforce the organisation policy `iam.disableServiceAccountKeyCreation` on the project, add a billing budget alert, and give a second person access to the project if wanted.
5. Run the first signed release with a pre-release tag and check step 6 of "Cutting a release"; the negative tests (pull request, fork, branch, other workflow all refused by Google) need a real GitHub OIDC token and were not run.

## Code signing

Windows: free signing through the [SignPath Foundation](https://signpath.org) is planned (see the code signing policy in the README); the disabled `sign-windows` job is its stub. macOS: Developer ID signing and notarisation need an Apple Developer Program membership; the disabled `notarize-macos` job is its stub. Until they are enabled, Windows and macOS archives are unsigned and the release notes say so. The bundled Node.js runtime binaries carry their publisher's own signatures.
