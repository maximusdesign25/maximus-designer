// ═══════════════════════════════════════════════════════════
//  LV V2.3 · admin.js
//  Password-protected admin actions.
//  Body: { password, action, ...args }
//  Actions:
//    'list'             → list all licenses + devices
//    'createKey'        → generate a new license key (3-device default)
//    'deactivateDevice' → remove one device from a license
//    'revokeKey'        → mark a license as revoked
//    'deleteKey'        → permanently delete a license
// ═══════════════════════════════════════════════════════════
import { getStore } from '@netlify/blobs';

const DEFAULT_MAX_DEVICES = 3;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function generateKey() {
  // 4 blocks of 4 alphanumeric chars, hyphen-separated. e.g. LV4A-9KX2-PM7Q-3FRT
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/1/I/O for readability
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) out += '-';
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, reason: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { ok: false, reason: 'Invalid request body' }); }

  // ── Auth ────────────────────────────────────────────────
  const adminPw = process.env.ADMIN_PASSWORD;
  if (!adminPw) {
    return json(500, { ok: false, reason: 'ADMIN_PASSWORD environment variable not set on the server.' });
  }
  const givenPw = String(body.password || '');
  if (!timingSafeEqual(givenPw, adminPw)) {
    // Small delay to slow brute force
    await new Promise((r) => setTimeout(r, 600));
    return json(401, { ok: false, reason: 'Incorrect password.' });
  }

  const action = String(body.action || '');
  // Store renamed lv-licenses → scwp-licenses. New store is authoritative; legacy is a read-only fallback
  // (migrate-forward whenever we write). list merges both so no existing license disappears from the panel.
  const licenses = getStore('scwp-licenses');
  const legacy = getStore('lv-licenses');
  // Read preferring the new store (with its etag for compare-and-swap); fall back to legacy (no etag →
  // the write migrates it forward via onlyIfNew). Returns { license, etag }.
  const readLicenseMeta = async (k) => {
    const e = await licenses.getWithMetadata(k, { type: 'json' });
    if (e && e.data) return { license: e.data, etag: e.etag };
    const old = await legacy.get(k, { type: 'json' });
    return old ? { license: old, etag: undefined } : { license: null, etag: undefined };
  };

  // ── list ────────────────────────────────────────────────
  if (action === 'list') {
    const seen = new Set();
    const all = [];
    // New store first (authoritative), then legacy for any keys not yet migrated forward.
    for (const store of [licenses, legacy]) {
      const { blobs } = await store.list();
      for (const blob of blobs) {
        if (seen.has(blob.key)) continue;
        const data = await store.get(blob.key, { type: 'json' });
        if (data) { seen.add(blob.key); all.push({ key: blob.key, ...data }); }
      }
    }
    // Sort by created date desc
    all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json(200, { ok: true, licenses: all });
  }

  // ── createKey ───────────────────────────────────────────
  if (action === 'createKey') {
    const maxDevices = Number.isInteger(body.maxDevices) && body.maxDevices > 0
      ? body.maxDevices
      : DEFAULT_MAX_DEVICES;
    const note = String(body.note || '').slice(0, 200);

    // Key: either admin-supplied (custom) or auto-generated.
    let key, exists;
    const rawCustom = body.key == null ? '' : String(body.key).trim();
    if (rawCustom) {
      // Custom key. Normalize to the SAME canonical form auto-generated keys use — uppercase, 4 groups of 4,
      // hyphen-separated — because activation only trims + uppercases the typed key (no hyphen stripping), so
      // the stored key must match exactly what the user will type. Hyphens/spaces in the input are ignored.
      const cleaned = rawCustom.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (cleaned.length !== 16) {
        return json(400, { ok: false, reason: 'Custom key must be 16 letters/numbers (4 groups of 4).' });
      }
      key = cleaned.match(/.{1,4}/g).join('-');
      exists = (await licenses.get(key)) || (await legacy.get(key));
      if (exists) return json(409, { ok: false, reason: 'That key already exists — pick a different one.' });
    } else {
      // Auto-generate a unique key (retry on the astronomically unlikely collision).
      for (let i = 0; i < 5; i++) {
        key = generateKey();
        exists = (await licenses.get(key)) || (await legacy.get(key));
        if (!exists) break;
      }
      if (exists) return json(500, { ok: false, reason: 'Could not generate unique key. Try again.' });
    }

    const license = {
      createdAt: new Date().toISOString(),
      maxDevices,
      note,
      revoked: false,
      devices: [],
    };
    // onlyIfNew guards the new store against a race the get-check above could miss (and a re-used custom key).
    const writeRes = await licenses.setJSON(key, license, { onlyIfNew: true });
    if (writeRes && writeRes.modified === false) {
      return json(409, { ok: false, reason: rawCustom ? 'That key already exists — pick a different one.' : 'Key collision — try again.' });
    }
    return json(200, { ok: true, key, license });
  }

  // ── deactivateDevice ────────────────────────────────────
  if (action === 'deactivateDevice') {
    const key = String(body.key || '').trim().toUpperCase();
    const deviceId = String(body.deviceId || '');
    if (!key || !deviceId) return json(400, { ok: false, reason: 'Missing key or deviceId.' });

    for (let attempt = 0; attempt < 5; attempt++) {
      const { license, etag } = await readLicenseMeta(key);
      if (!license) return json(404, { ok: false, reason: 'License not found.' });

      const before = (license.devices || []).length;
      license.devices = (license.devices || []).filter((d) => d.deviceId !== deviceId);
      const after = license.devices.length;
      const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const res = await licenses.setJSON(key, license, writeOpts);
      if (res && res.modified === false) continue; // raced with another write — re-read and retry
      return json(200, { ok: true, removed: before - after });
    }
    return json(409, { ok: false, reason: 'License is busy — please try again in a moment.' });
  }

  // ── revokeKey ───────────────────────────────────────────
  if (action === 'revokeKey') {
    const key = String(body.key || '').trim().toUpperCase();
    if (!key) return json(400, { ok: false, reason: 'Missing key.' });

    for (let attempt = 0; attempt < 5; attempt++) {
      const { license, etag } = await readLicenseMeta(key);
      if (!license) return json(404, { ok: false, reason: 'License not found.' });

      license.revoked = true;
      license.revokedAt = new Date().toISOString();
      const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
      const res = await licenses.setJSON(key, license, writeOpts);
      if (res && res.modified === false) continue; // raced with another write — re-read and retry
      return json(200, { ok: true });
    }
    return json(409, { ok: false, reason: 'License is busy — please try again in a moment.' });
  }

  // ── deleteKey ───────────────────────────────────────────
  if (action === 'deleteKey') {
    const key = String(body.key || '').trim().toUpperCase();
    if (!key) return json(400, { ok: false, reason: 'Missing key.' });
    await licenses.delete(key);
    try { await legacy.delete(key); } catch (_) {}   // remove from the legacy store too
    return json(200, { ok: true });
  }

  return json(400, { ok: false, reason: 'Unknown action: ' + action });
};

export const config = { path: '/.netlify/functions/admin' };
