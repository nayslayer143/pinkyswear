# PinkySwear

PinkySwear is an offline-first field agreement tool. It creates documents, captures signatures, photos, and optional locations, and stores everything in the browser's IndexedDB database.

## Architecture

The application has no build step and is served directly from this directory.

- `index.html` contains the semantic application shell and dialogs.
- `styles.css` is the complete responsive design system; there are no build-time CSS directives.
- `core.js` contains pure validation, formatting, sanitization, and template utilities.
- `db.js` owns the versioned Dexie schema and all transactional persistence.
- `offlineSync.js` pushes and pulls cloud document changes, retries failed operations, and detects version conflicts.
- `populateTemplates.js` owns idempotent default template data.
- `app.js` coordinates UI state and delegates persistence and sync work to those layers.
- `service-worker.js` caches the app shell and pinned browser dependencies for offline use.
- `server.js` stores authenticated cloud profiles and user-scoped sync metadata. Document payloads are encrypted before upload to blob storage.
- `backend/integrations.md` describes the active backend, sync limits, and remaining production requirements.

The browser database remains `PinkySwearDB`, so upgrades preserve existing local data. Schema version 5 adds local profile ownership, client UUIDs, tombstones, signed-document metadata, remote versions, idempotent queue operations, retry metadata, and seed metadata. Document writes and related evidence updates are atomic transactions.

## Local development

Serve `/workspace` with any static HTTP server. In Websim the project is already available at the live preview URL; no install or build command is required.

Do not open `index.html` directly from `file://`: service workers, camera access, clipboard access, and module loading require an HTTP origin.

## Tests

Open `/tests.html` from the same static server. The dependency-free browser suite exercises normalization, template replacement, rich-text sanitization, backup validation, filenames, and data URL validation. A red test prevents the final success summary.

The Cloudflare `/api` backend has a Node suite: `node --test 'tests/*.node.test.mjs'`. See `deploy/README.md`.

For smoke testing, verify these workflows in a fresh browser profile:

1. Create two device profiles and confirm their document lists stay separate.
2. Save a draft, sign it, reopen it read-only, then create an amendment.
3. Capture location; add camera and uploaded photos; export a PDF with evidence.
4. Create, configure, edit, preview, and delete a template.
5. Export and re-import a backup, including a signed document.
6. Create a cloud profile and confirm it syncs on a second signed-in device.
7. Edit one document on both devices and resolve the version conflict both ways.
8. Reload while offline and confirm the workspace still opens.
9. Navigate using only a keyboard and with reduced-motion enabled.

## Production limitations

Documents and templates remain device-local for device-only profiles. Creating a cloud profile enables document sync across that signed-in Websim account. Cloud records are authorized by trusted user identity; encrypted blobs are public URLs, so document payloads are encrypted before storage. Device profile names and roles remain local labels.

Cloud profiles use Websim's authenticated identity and are server-authorized. Device-only profiles remain available offline and are intentionally labeled as local. Profile signatures are stored as compact drawing strokes or typed-signature settings; they are not uploaded as public images.

Third-party browser libraries are version-pinned but loaded from CDNs. A hardened deployment should self-host them or add verified Subresource Integrity hashes and enforce a server-delivered Content Security Policy.

## Cloud sync limits

Cloud sync requires a signed-in Websim account and a PinkySwear cloud profile. A document payload, including its attachments, is limited to 4.4 MB per sync operation. Local data remains available offline; the sync queue resumes when the device reconnects. Conflicting edits pause for a user choice between the cloud copy and this device's copy.
