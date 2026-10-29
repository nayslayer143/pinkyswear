// End-to-end test of the Cloudflare /api backend: functions/api/[[path]].js wrapping server.js,
// over SQLite stand-ins for D1, a Map for R2, and a local RSA key posing as Google's JWKS.
// Run with: node --test 'tests/*.node.test.mjs'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const { onRequest } = await import(new URL('../functions/api/[[path]].js', import.meta.url));
const { CONSENT_TEXT } = await import(new URL('../functions/_lib/registry.js', import.meta.url));

function d1(sql) {
  const db = new DatabaseSync(':memory:');
  db.exec(sql);
  const statement = (query, params = []) => ({
    bind: (...values) => statement(query, values),
    async first(column) { const row = db.prepare(query).get(...params); return row && column ? row[column] : row ?? null; },
    async all() { return { results: db.prepare(query).all(...params) }; },
    async run() { const { changes } = db.prepare(query).run(...params); return { meta: { changes } }; }
  });
  return { raw: db, prepare: (query) => statement(query), async batch(list) { for (const item of list) await item.run(); } };
}

const REGISTRY_SQL = `
  CREATE TABLE people (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, phone TEXT, handle TEXT,
    sms_consent INTEGER NOT NULL DEFAULT 0, sms_consent_at TEXT, sms_consent_text TEXT, remove_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE signups (person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE, app TEXT NOT NULL, pool TEXT NOT NULL,
    consent_version TEXT NOT NULL, consent_text TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (person_id, app));
  CREATE TABLE removals (email TEXT PRIMARY KEY, removed_at TEXT NOT NULL);`;

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ORIGIN = 'https://pinkyswear.asdfghjk.lol';
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url) === 'https://www.googleapis.com/oauth2/v3/certs'
  ? Response.json({ keys: [jwk] }, { headers: { 'cache-control': 'max-age=3600' } })
  : realFetch(url, init);

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
async function googleToken(claims, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, iat: now, exp: now + 600, email_verified: true, ...claims }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function harness(extraEnv = {}) {
  const objects = new Map();
  const env = {
    DB: d1(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8')),
    REGISTRY: d1(REGISTRY_SQL),
    SYNC_BUCKET: {
      async put(key, data) { objects.set(key, new Uint8Array(data)); },
      async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; }
    },
    GOOGLE_CLIENT_ID: CLIENT_ID,
    ...extraEnv
  };
  const call = (path, { method = 'GET', cookie = '', headers = {}, body } = {}) => onRequest({
    env,
    request: new Request(`${ORIGIN}${path}`, {
      method,
      headers: { Accept: 'application/json', ...(cookie && { cookie }), ...(body && { 'Content-Type': 'application/json', Origin: ORIGIN }), ...headers },
      body: body && JSON.stringify(body)
    })
  });
  async function signIn(claims) {
    const nonceResponse = await call('/api/auth/nonce');
    const { nonce } = await nonceResponse.json();
    const credential = await googleToken({ nonce, ...claims });
    const response = await call('/api/auth/google', { method: 'POST', cookie: `ps_google_nonce=${nonce}`, body: { credential } });
    const session = /ps_google_session=([^;]+)/.exec(response.headers.get('set-cookie') || '')?.[1];
    return { response, nonce, credential, cookie: session ? `ps_google_session=${session}` : '' };
  }
  return { env, objects, call, signIn };
}

test('auth config serves the client ID from the environment', async () => {
  const { call } = harness();
  assert.deepEqual(await (await call('/api/auth/config')).json(), { clientId: CLIENT_ID });
});

test('Websim identity headers are ignored off Websim', async () => {
  const { call } = harness();
  const spoof = { 'x-websim-user-id': 'u1', 'x-websim-username': 'nayslayer143', 'x-websim-user-is-anonymous': 'false' };
  assert.equal((await (await call('/api/session', { headers: spoof })).json()).authenticated, false);
  assert.equal((await call('/api/admin/overview', { headers: spoof })).status, 403);
});

test('a first Google sign-in creates the account, a session and one shared sign-up', async () => {
  const { env, call, signIn } = harness();
  const first = await signIn({ sub: '1000001', email: 'Agent@Example.com', name: 'Field Agent One' });
  assert.equal(first.response.status, 200);
  assert.ok(first.cookie);
  const session = await (await call('/api/session', { cookie: first.cookie })).json();
  assert.equal(session.authenticated, true);
  assert.equal(session.provider, 'google');
  assert.equal(session.isAdmin, false);

  const people = env.REGISTRY.raw.prepare('SELECT email, name FROM people').all();
  assert.deepEqual(people.map((row) => ({ ...row })), [{ email: 'agent@example.com', name: 'Field Agent One' }]);
  const signups = env.REGISTRY.raw.prepare('SELECT app, pool, consent_text FROM signups').all();
  assert.deepEqual(signups.map((row) => ({ ...row })), [{ app: 'pinkyswear', pool: 'omega-mega', consent_text: CONSENT_TEXT }]);

  const again = await signIn({ sub: '1000001', email: 'agent@example.com', name: 'Renamed' });
  assert.equal(again.response.status, 200);
  assert.equal(env.REGISTRY.raw.prepare('SELECT COUNT(*) AS n FROM signups').get().n, 1);
  assert.equal(env.REGISTRY.raw.prepare('SELECT name FROM people').get().name, 'Field Agent One');
});

test('someone already on the list keeps their details and gains this app', async () => {
  const { env, signIn } = harness();
  env.REGISTRY.raw.exec(`INSERT INTO people (id, email, name, remove_token, created_at, updated_at) VALUES ('p1', 'known@example.com', 'Known Name', 't1', 'x', 'x');
    INSERT INTO signups VALUES ('p1', 'tango', 'omega-mega', 'v', 'c', 'x');`);
  await signIn({ sub: '1000002', email: 'known@example.com', name: 'Other Name' });
  assert.deepEqual(env.REGISTRY.raw.prepare("SELECT app FROM signups WHERE person_id = 'p1' ORDER BY app").all().map((row) => row.app), ['pinkyswear', 'tango']);
  assert.equal(env.REGISTRY.raw.prepare("SELECT name FROM people WHERE id = 'p1'").get().name, 'Known Name');
});

test('a pending removal is respected', async () => {
  const { env, signIn } = harness();
  env.REGISTRY.raw.exec("INSERT INTO removals VALUES ('gone@example.com', 'x')");
  assert.equal((await signIn({ sub: '1000003', email: 'gone@example.com', name: 'Gone' })).response.status, 200);
  assert.equal(env.REGISTRY.raw.prepare('SELECT COUNT(*) AS n FROM people').get().n, 0);
});

test('forged, replayed and wrong-audience credentials are rejected', async () => {
  const { call, signIn } = harness();
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const nonce = (await (await call('/api/auth/nonce')).json()).nonce;
  const forged = await googleToken({ sub: '9', email: 'x@example.com', nonce }, other.privateKey);
  assert.equal((await call('/api/auth/google', { method: 'POST', cookie: `ps_google_nonce=${nonce}`, body: { credential: forged } })).status, 401);

  const used = await signIn({ sub: '1000004', email: 'replay@example.com' });
  assert.equal(used.response.status, 200);
  assert.equal((await call('/api/auth/google', { method: 'POST', cookie: `ps_google_nonce=${used.nonce}`, body: { credential: used.credential } })).status, 401);

  const nonce2 = (await (await call('/api/auth/nonce')).json()).nonce;
  const wrongAud = await googleToken({ sub: '9', email: 'x@example.com', nonce: nonce2, aud: 'someone-else.apps.googleusercontent.com' });
  assert.equal((await call('/api/auth/google', { method: 'POST', cookie: `ps_google_nonce=${nonce2}`, body: { credential: wrongAud } })).status, 401);
});

test('ADMIN_GOOGLE_EMAILS grants admin to a verified Google account', async () => {
  const { call, signIn } = harness({ ADMIN_GOOGLE_EMAILS: 'boss@example.com' });
  const boss = await signIn({ sub: '1000005', email: 'boss@example.com', name: 'Boss' });
  assert.equal((await (await call('/api/session', { cookie: boss.cookie })).json()).isAdmin, true);
  assert.equal((await call('/api/admin/overview', { cookie: boss.cookie })).status, 200);
});

test('documents sync through R2 encrypted and come back intact', async () => {
  const { objects, call, signIn } = harness();
  const { cookie } = await signIn({ sub: '1000006', email: 'sync@example.com', name: 'Sync' });
  const payload = { title: 'Fence repair', content: 'Both parties swear.', photos: [] };
  const response = await call('/api/sync', {
    method: 'POST', cookie, headers: { 'Idempotency-Key': 'op-1' },
    body: { operationId: 'op-1', entity: 'document', action: 'create', clientId: 'doc-1', baseVersion: 0, payload }
  });
  assert.deepEqual(await response.json(), { ok: true, version: 1 });
  assert.equal(objects.size, 1);
  const stored = [...objects.values()][0];
  assert.ok(!Buffer.from(stored).toString('utf8').includes('Fence repair'));
  const listed = await (await call('/api/sync', { cookie })).json();
  assert.deepEqual(listed.documents[0].payload, payload);
});
