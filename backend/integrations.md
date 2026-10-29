# Backend and sync contract

PinkySwear uses IndexedDB as the local source of truth. Signed-in Websim and Google accounts can create a cloud profile and sync their documents across devices.

## Active routes

- `GET /api/session` returns the trusted account identity and the caller's cloud profile.
- `PUT /api/profile` creates or updates the caller's profile.
- `GET /api/sync` returns the caller's cloud documents in pages of 25. `?clientId=...` returns one document for conflict resolution.
- `POST /api/sync` accepts one idempotent document create, update, or delete operation.
- `GET /api/auth/config`, `GET /api/auth/nonce`, `POST /api/auth/google`, and `POST /api/auth/logout` support Google Identity Services sign-in with server-side ID-token verification and opaque HttpOnly sessions.
- `GET /api/admin/overview` and `PUT /api/admin/settings` expose the API controls only to the trusted Websim account `@atozenith`.
- `POST /api/brand/analyze` and `GET /api/brand/logo` honor admin feature controls; sync endpoints honor the document sync switch.

Websim sessions use the trusted `x-websim-user-id` header. Google sessions use a server-issued, HttpOnly cookie whose random token is stored only as a SHA-256 hash. Both resolve to a server-controlled user scope; clients cannot choose another account's scope.

## Cloudflare deployment

The Cloudflare Pages deployment at `pinkyswear.asdfghjk.lol` runs this same `server.js` behind `functions/api/[[path]].js`. That wrapper strips every `x-websim-*` header, so Google sign-in is the only identity there; it stores encrypted payloads in R2 and records first sign-ins in the shared Omega sign-up list. The OAuth client ID comes from the `GOOGLE_CLIENT_ID` variable and admin access from `ADMIN_GOOGLE_EMAILS`. Bindings and setup are in `deploy/README.md`.

## Google sign-in setup

1. Create a Google OAuth client with application type **Web application** in Google Cloud Console.
2. Add the published app origin and any development origin under **Authorized JavaScript origins**.
3. Sign into PinkySwear as the trusted Websim account `@atozenith`, open **Admin**, and save the OAuth Web client ID. The client ID is public; no client secret belongs in this project.
4. Reload the landing page and use **Continue with Google**. Google signs the ID token; the backend verifies its signature, issuer, audience, expiry, nonce, and verified email before issuing the app session.

The server-side Google admin subject is intentionally unset. Admin access remains tied to the trusted `@atozenith` Websim identity; a Google email or editable profile handle cannot grant admin access.

## Document storage

The browser sends a document payload over HTTPS. The backend encrypts its JSON with AES-GCM before writing it to `env.BLOB`; it stores only the encrypted blob URL and sync metadata in D1. The encryption key is stored in the private D1 database under the same user ID. Blob URLs are public, but the blob contents are encrypted. The server can decrypt a document after checking the caller's identity.

Each document has a client UUID and monotonically increasing server version. Each operation has an idempotency UUID. Updating a stale version returns `409 Conflict`; the client fetches the cloud copy and offers **Use cloud copy** or **Keep this copy**. Deletion creates a tombstone so other devices can remove the record.

The full serialized document, including its signature image, photos, and location, must fit within 4.4 MB per operation. The client keeps oversized changes locally and shows the sync error. Browser attachment limits are 12 photos per document.

## Security and product limits

- Cloud data is encrypted in blob storage, but encryption keys are held by the backend. This is server-side encryption, not end-to-end encryption.
- A device-only profile is a local label. Anyone with access to the same browser profile can open its local documents.
- The drawn or typed signature is an image plus signer name and timestamp. It does not provide a cryptographic signature, identity proof, or append-only audit evidence.
- Replacing a cloud document writes a new encrypted blob. Old encrypted blobs may remain in storage; automated blob retention and deletion are not implemented.
- Imported backups contain plaintext document and evidence data. Store exported backup files carefully.
- The server accepts only supported document fields, validates attachment types and sizes, and derives account ownership from trusted identity headers.

Before using the app for regulated or legally consequential records, add a retention policy, tested backup restoration, operational monitoring, and an audit process appropriate to that use. A browser-stored signature image should not be presented as proof of identity.
