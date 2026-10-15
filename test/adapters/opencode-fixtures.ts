/**
 * OpenCode 2.x fixtures and a fake v2 server.
 *
 * PROVENANCE (2026-10-15, OpenCode v2.0.21, Linux):
 *  - LIVE: the empty-state bodies below (`V2_LIVE_*`) are byte-for-byte what a private `opencode serve` (temporary HOME, no sessions, no
 *    model call) answered, with HTTP Basic credentials `opencode:<OPENCODE_SERVER_PASSWORD>`; without credentials it answered every
 *    /api/* route with 401 and `V2_LIVE_UNAUTHORIZED`, and answered the 1.x paths (`/session/status`) with its web app (HTML, 200).
 *    The folder in `location.directory` was replaced with a neutral one.
 *  - FROM THE OPENAPI DOCUMENT (`GET /openapi.json` of the same server): the populated items below follow the response schemas of
 *    `session.list`, `session.active`, `permission.request.list` and `form.list`. They were not recorded from a live session (that needs
 *    a model), so populated rows are fixture-verified only.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';

export const V2_LIVE_ACTIVE_EMPTY = '{"data":{}}';
export const V2_LIVE_LIST_EMPTY = '{"data":[],"cursor":{"previous":null,"next":null}}';
export const V2_LIVE_PENDING_EMPTY = '{"location":{"directory":"/work/game"},"data":[]}';
export const V2_LIVE_UNAUTHORIZED = '{"_tag":"UnauthorizedError","message":"Authentication required"}';
export const V2_LIVE_SPA_HTML = '<!doctype html><html><head><title>OpenCode</title></head><body></body></html>';

export interface V2Content { content: string; folder: string; now: number }

/** Populated v2 bodies (schema-derived). `content` is planted in every field a real machine fills with private text. */
export function v2Bodies(o: V2Content) {
  const session = (id: string, extra: Record<string, unknown> = {}, updatedAgo = 1000) => ({
    id, projectID: 'prj_1', title: `T ${o.content}`, agent: 'build', cost: 1.5,
    model: { id: 'm', providerID: 'p' }, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: o.now - 60_000, updated: o.now - updatedAgo },
    metadata: { note: o.content }, permissions: [{ action: 'bash', resource: o.content, effect: 'ask' }],
    location: { directory: o.folder }, ...extra,
  });
  return {
    active: { data: { ses_a: { type: 'running' }, ses_paged: { type: 'running' } } },
    list: {
      data: [
        session('ses_a'),
        session('ses_b', { parentID: 'ses_a' }, 2000),
        session('ses_wait', {}, 3000),
        session('ses_ask', {}, 4000),
        session('ses_old', {}, 3 * 3600_000),
      ],
      cursor: { previous: null, next: null },
    },
    permissions: {
      location: { directory: o.folder },
      data: [{
        id: 'per_1', sessionID: 'ses_wait', action: 'bash', resources: [`rm -rf ${o.content}`], save: [o.content],
        metadata: { command: o.content }, source: { type: 'tool', messageID: 'msg_1', id: 'call_1' }, message: `Run ${o.content}?`,
      }],
    },
    forms: {
      location: { directory: o.folder },
      data: [{ id: 'frm_1', sessionID: 'ses_ask', metadata: { q: o.content }, fields: [{ key: 'k', label: o.content, type: 'string' }] }],
    },
  };
}

export interface FakeV2 { port: number; requests: { method: string; url: string; authorization: string | undefined }[]; close: () => Promise<void>; server: Server }

/**
 * A fake OpenCode 2.x server: Basic auth when `password` is set (401 with the live body otherwise), routes answer `{...}` bodies,
 * the 1.x paths answer the web app HTML, anything else 404. Every request is recorded with its Authorization header.
 */
export async function fakeOpencodeV2(routes: Record<string, string | object | ((req: IncomingMessage) => string | object)>, opts: { password?: string; user?: string } = {}): Promise<FakeV2> {
  const requests: FakeV2['requests'] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization });
    const url = req.url ?? '';
    if (url.startsWith('/api/') && opts.password !== undefined) {
      const want = `Basic ${Buffer.from(`${opts.user ?? 'opencode'}:${opts.password}`).toString('base64')}`;
      if (req.headers.authorization !== want) { res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="Secure Area"' }); res.end(V2_LIVE_UNAUTHORIZED); return; }
    }
    const r = routes[url];
    if (r === undefined) {
      if (url === '/session/status' || url === '/session') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(V2_LIVE_SPA_HTML); return; }
      res.writeHead(404); res.end('not found'); return;
    }
    const body = typeof r === 'function' ? r(req) : r;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { port, requests, server, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}
