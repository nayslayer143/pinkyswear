# Cloudflare deployment

PinkySwear runs on Cloudflare Pages as project `pinkyswear`. The static app shell is served from Pages, and `/api/*` runs `functions/api/[[path]].js`, which wraps `server.js`.

`deploy.sh` copies only the app shell into a scratch directory before uploading. `server.js`, the tests, the docs and any session files never become public URLs; `server.js` reaches Cloudflare only inside the bundled Functions.

## Bindings

Bindings are set on the Pages project's production environment, not in this repository.

| Binding | Type | Resource | Purpose |
|---|---|---|---|
| `DB` | D1 | `pinkyswear` | Accounts, sessions, profiles, sync metadata and document keys. Schema: `migrations/0001_init.sql`. |
| `SYNC_BUCKET` | R2 | `pinkyswear-sync` | AES-GCM encrypted document payloads. The bucket is private; objects are read back through the Function. |
| `REGISTRY` | D1 | `omega-waitlist` | The shared Omega sign-up list. A first Google sign-in adds the person and a `pinkyswear` signup row. |
| `GOOGLE_CLIENT_ID` | Variable | — | The OAuth Web client ID. It is public; no client secret is used. |
| `ADMIN_GOOGLE_EMAILS` | Secret, optional | — | Comma-separated verified Google emails that get the Admin panel. |

Preview deployments have no bindings, so preview URLs serve the shell with a non-working `/api`.

## Identity

The wrapper deletes every `x-websim-*` request header before `server.js` sees the request. On Websim those headers come from Websim's edge; anywhere else a caller can forge them. Google sign-in is the only identity on this deployment.

Admin access comes from `ADMIN_GOOGLE_EMAILS` and applies only to Google sessions with a verified email.

Brand analysis needs an LLM and is turned off here until it can use the user's own API key.

## Shared sign-up list

Every Omega, Shiny and asdfghjk app keeps its own accounts and also writes each new sign-up to the shared `omega-waitlist` database. `functions/_lib/registry.js` does that for PinkySwear.

- Only a first Google sign-in writes to the shared list, so signing in again never re-adds someone who asked to be removed.
- An address in `removals` is never written.
- A person already on the list keeps their stored name and gains a `pinkyswear` signup row.
- The consent text stored with the row is the same sentence shown beside the Google button (`SIGNUP_NOTICE` in `app.js`).

The waitlist service must list `pinkyswear` in its app registry so its CRM sync accepts these rows.

## First-time setup

1. Create the D1 database `pinkyswear` and apply `migrations/0001_init.sql`.
2. Create the R2 bucket `pinkyswear-sync`.
3. Add the bindings above to the Pages project's production environment.
4. In Google Cloud Console, create an OAuth client of type **Web application** with `https://pinkyswear.asdfghjk.lol` under **Authorized JavaScript origins**. The consent screen must be External and published; the basic `openid email profile` scopes need no verification.
5. Set `GOOGLE_CLIENT_ID` on the Pages project and deploy again.

## Deploy

```bash
CLOUDFLARE_ACCOUNT_ID=<asdfghjk.lol account> CLOUDFLARE_API_TOKEN=<token> ./deploy/deploy.sh
```

`./deploy/deploy.sh --stage-only <dir>` copies the staged shell into `<dir>` without uploading.

## Tests

```bash
node --test 'tests/*.node.test.mjs'
```

The suite runs the Function against SQLite stand-ins for both D1 databases, an in-memory R2 bucket and a locally generated key posing as Google's signing keys. It covers forged Websim headers, forged and replayed Google tokens, the shared sign-up rules, admin by email and an encrypted sync round trip.
