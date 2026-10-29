// Cloudflare Pages entry for /api/*. server.js was written for Websim, whose edge sets the
// x-websim-* identity headers; off Websim anyone can send them, so they are stripped here and
// Google sign-in is the only identity. The env adapter maps Websim's blob store to R2 and
// hands server.js the shared sign-up registry. Bindings live on the Pages project, not in
// this public repo: DB (D1 pinkyswear), SYNC_BUCKET (R2), REGISTRY (D1 omega-waitlist).
import worker from '../../server.js';
import { recordSignup } from '../_lib/registry.js';

function blobStore(bucket) {
  return {
    async put(key, data, { contentType } = {}) {
      await bucket.put(key, data, { httpMetadata: { contentType } });
      return { url: `r2:${key}` };
    },
    async fetch(url) {
      const object = url.startsWith('r2:') ? await bucket.get(url.slice(3)) : null;
      return object ? new Response(object.body) : new Response(null, { status: 404 });
    }
  };
}

// Brand analysis needs an LLM; until it takes the user's own key it stays off here.
const noAi = { async chat() { throw new Error('Brand analysis is not available on this deployment yet.'); } };

export async function onRequest({ request, env }) {
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.startsWith('x-websim-')) headers.delete(name);
  return worker.fetch(new Request(request, { headers }), {
    ...env,
    BLOB: blobStore(env.SYNC_BUCKET),
    AI: noAi,
    recordSignup: env.REGISTRY ? (person) => recordSignup(env.REGISTRY, person) : undefined
  });
}
