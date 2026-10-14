/**
 * A loopback mock of the two Cloud KMS REST calls the release signer uses, for tests and the CI dry run (no network, no credentials).
 * It enforces what the real service enforces that matters here: a bearer token, the 64 KiB Ed25519 data limit, request/response CRC32C.
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { crc32c } from './kms.mjs';

/**
 * @param {{ privateKeyPem: string, resource: string, tamperSignature?: boolean, wrongCrc?: boolean }} o
 * @returns {Promise<{ url: string, calls: { path: string, bytes: number, auth: string }[], close: () => Promise<void> }>}
 */
export async function startMockKms(o) {
  const priv = createPrivateKey(o.privateKeyPem);
  const pem = createPublicKey(priv).export({ type: 'spki', format: 'pem' }).toString();
  const calls = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const auth = String(req.headers.authorization ?? '');
      const path = (req.url ?? '').split('?')[0];
      calls.push({ path, bytes: Buffer.concat(chunks).length, auth: auth ? 'present' : 'absent' });
      if (!auth.startsWith('Bearer ') || auth.length < 12) return send(401, { error: { status: 'UNAUTHENTICATED' } });
      if (req.method === 'GET' && path === `/v1/${o.resource}/publicKey`) return send(200, { pem, algorithm: 'EC_SIGN_ED25519', name: o.resource });
      if (req.method === 'POST' && path === `/v1/${o.resource}:asymmetricSign`) {
        let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: { status: 'INVALID_ARGUMENT' } }); }
        const data = Buffer.from(String(body.data ?? ''), 'base64');
        if (data.length > 65_536) return send(400, { error: { status: 'INVALID_ARGUMENT' } });
        if (body.dataCrc32c !== undefined && String(body.dataCrc32c) !== String(crc32c(data))) return send(400, { error: { status: 'INVALID_ARGUMENT' } });
        const sig = sign(null, data, priv);
        if (o.tamperSignature) sig[0] ^= 1;
        return send(200, { name: o.resource, signature: sig.toString('base64'), verifiedDataCrc32c: !o.wrongCrc, signatureCrc32c: String(crc32c(sig)) });
      }
      return send(404, { error: { status: 'NOT_FOUND' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => server.close(() => r())) };
}
