// The shared sign-up list. Every Omega / Shiny / asdfghjk app keeps its own accounts and also
// records each new sign-up in the omega-waitlist D1 (people + signups), which syncs to Twenty.
// Only a first Google sign-in calls this, so signing in again never re-adds someone who asked
// to be removed. A person already on the list keeps their stored name; they just gain this app.
export const APP = 'pinkyswear';
export const POOL = 'omega-mega';
export const CONSENT_VERSION = '2026-10-28.account-v1';
// Shown verbatim beside the Google button (app.js SIGNUP_NOTICE); keep the two identical.
export const CONSENT_TEXT = 'Signing in also adds your name and email to the Omega MegaCorp sign-up list, so we may email you about PinkySwear and related Omega products. To be removed, email jordan@asdfghjk.lol.';

function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function recordSignup(db, { email, name }) {
  const address = String(email || '').trim().toLowerCase();
  if (!address.includes('@')) return;
  if (await db.prepare('SELECT 1 FROM removals WHERE email = ?').bind(address).first()) return;
  const now = new Date().toISOString();
  const existing = await db.prepare('SELECT id FROM people WHERE email = ?').bind(address).first();
  const id = existing?.id ?? crypto.randomUUID();
  const signup = db.prepare(`INSERT OR IGNORE INTO signups (person_id, app, pool, consent_version, consent_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).bind(id, APP, POOL, CONSENT_VERSION, CONSENT_TEXT, now);
  if (existing) { await signup.run(); return; }
  await db.batch([
    db.prepare(`INSERT INTO people (id, email, name, remove_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, address, String(name || address.split('@')[0]).slice(0, 80), token(), now, now),
    signup
  ]);
}
