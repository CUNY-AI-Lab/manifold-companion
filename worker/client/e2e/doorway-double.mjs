// Local Doorway double for the end-to-end journey. Like Doorway it: strips any
// caller-supplied x-cail-* headers and cookies, mints a fresh app leg
// (aud cail:manifold-companion) and a same-subject Gateway leg with a REAL
// signing key (cail-identity test issuer), forwards the ORIGINAL path to the
// Worker, answers /launch/manifold-companion with a redirect to the app, and
// answers signed-out API calls with 401 authentication_required. Who is signed
// in is chosen by the test with a cookie (e2e_as=alice|bob|carol|dave|none).
//
// It starts `wrangler dev` itself (real workerd, local D1 and R2, the Gateway
// stub on the GATEWAY service binding) with the issuer's JWKS as a var.
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { canonicalTestSubject, createTestIdentityIssuer, TEST_SUBJECTS } from '@cuny-ai-lab/cail-identity/testing';

const here = import.meta.dirname;
const worker = resolve(here, '../..');
const PORT = Number(process.env.E2E_PORT ?? 8790);
const WRANGLER_PORT = Number(process.env.E2E_WRANGLER_PORT ?? 8791);
const origin = `http://127.0.0.1:${PORT}`;
const state = join(here, '.state');
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

const issuer = await createTestIdentityIssuer();
const wrangler = join(worker, 'node_modules/.bin/wrangler');
execFileSync(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: worker, stdio: 'inherit', env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
const vars = { CAIL_IDENTITY_JWKS: issuer.jwksJson, CAIL_IDENTITY_ISSUER: issuer.issuer, CAIL_CANONICAL_ORIGIN: origin, CAIL_LOG_ENV: 'test' };
const dev = spawn(wrangler, ['dev', '-c', 'wrangler.jsonc', '-c', join(here, 'gateway-stub.jsonc'), '--port', String(WRANGLER_PORT), '--ip', '127.0.0.1', '--local-upstream', `127.0.0.1:${PORT}`, '--persist-to', state, ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])], { cwd: worker, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' } });
process.on('exit', () => dev.kill());
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dev.kill(); process.exit(0); });

let launches = 0;
// dave never creates anything: the first-run screens.
const SUBJECTS = { alice: TEST_SUBJECTS.alice, bob: TEST_SUBJECTS.bob, carol: TEST_SUBJECTS.carol, dave: canonicalTestSubject('dave') };
const who = (cookie = '') => /(?:^|;\s*)e2e_as=([a-z]+)/.exec(cookie)?.[1] ?? 'alice';

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.pathname === '/health/live') { res.writeHead(200).end('ok'); return; }
    if (url.pathname === '/__e2e/launches') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ launches })); return; }
    // Real Doorway starts CUNY Login here; the double "signs in" as alice and returns to the app.
    if (url.pathname === '/launch/manifold-companion') {
      launches += 1;
      res.writeHead(302, { location: '/manifold-companion/', 'set-cookie': 'e2e_as=alice; Path=/' }).end();
      return;
    }
    if (url.pathname === '/__e2e/launches') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ launches })); return; }
    if (!url.pathname.startsWith('/manifold-companion')) { res.writeHead(404).end(); return; }
    const as = who(req.headers.cookie);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith('x-cail-') || k === 'cookie' || k === 'authorization' || k === 'host' || k === 'connection' || k === 'content-length') continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    }
    if (as === 'none') {
      if (url.pathname.startsWith('/manifold-companion/api')) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'session_invalid', message: 'Sign in again.', launch: '/launch/manifold-companion' } }));
        return;
      }
    } else {
      const subject = SUBJECTS[as];
      headers.set('x-cail-identity-jwt', await issuer.mintIdentityJwt({ audience: 'cail:manifold-companion', subject }));
      headers.set('x-cail-gateway-identity-jwt', await issuer.mintIdentityJwt({ audience: 'cail:gateway', subject }));
    }
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
    const upstream = await fetch(`http://127.0.0.1:${WRANGLER_PORT}${url.pathname}${url.search}`, { method: req.method, headers, body, duplex: 'half', redirect: 'manual' });
    const out = {};
    upstream.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v; });
    res.writeHead(upstream.status, out);
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    res.end();
  } catch (error) {
    res.writeHead(502).end(`doorway double: ${error?.name}`);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`doorway double on ${origin}`));
