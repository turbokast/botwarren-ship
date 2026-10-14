/**
 * A REAL manifest signed by the production Cloud KMS key (kms-2026a) on 2026-10-14 with scripts/release-sign.mjs --kms, as the compatibility
 * proof that KMS Ed25519 signatures verify with the agent's pinned key. It describes a harmless fake release (0.0.1, rolloutBp 0, a bundle hash
 * nobody can satisfy) and expires 2026-11-14, so replaying it does nothing. Tests must pass `now` explicitly.
 */
export const KMS_FIXTURE_MANIFEST = "{\n  \"schema\": 1,\n  \"epoch\": 1,\n  \"manifestVersion\": 1,\n  \"issued\": \"2026-10-14T00:00:00.000Z\",\n  \"expires\": \"2026-11-14T00:00:00.000Z\",\n  \"channels\": {\n    \"stable\": \"0.0.1\"\n  },\n  \"minSupported\": \"0.0.1\",\n  \"blocked\": [],\n  \"rollbackFrom\": [],\n  \"releases\": {\n    \"0.0.1\": {\n      \"protocol\": {\n        \"min\": 1,\n        \"max\": 1\n      },\n      \"rolloutBp\": 0,\n      \"rolloutSalt\": \"kms-fixture\",\n      \"critical\": false,\n      \"bundle\": {\n        \"url\": \"bundle-0.0.1.zip\",\n        \"sha256\": \"f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d\",\n        \"size\": 7\n      },\n      \"full\": {}\n    }\n  }\n}\n";
export const KMS_FIXTURE_SIG = "{\"alg\":\"ed25519\",\"keyId\":\"kms-2026a\",\"sig\":\"tvTZKk5P7hASDeakrS9p3d0EeQgZUx73JYeRvm4a5DQmoEY58jZBpldTD4YEC3Hdsp5d2YwIkfJcUSKLRB0IAw==\"}\n";
export const KMS_FIXTURE_NOW = new Date('2026-10-15T00:00:00.000Z');
