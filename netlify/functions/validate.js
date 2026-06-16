// ═══════════════════════════════════════════════════════════
//  LV V2.3 · validate.js
//  Re-validates a device on every app open. Updates lastSeen.
//  Body: { key, deviceId }
//  Response: { valid: true } OR { valid: false, reason }
// ═══════════════════════════════════════════════════════════
import { getStore } from '@netlify/blobs';

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { valid: false, reason: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { valid: false, reason: 'Invalid request body' }); }

  const key = String(body.key || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '').trim();

  if (!key || !deviceId) return json(400, { valid: false, reason: 'Missing credentials.' });

  // Store renamed lv-licenses → scwp-licenses. Read the new store first, fall back to the legacy store
  // so existing licenses keep validating; the setJSON below writes to the new store, migrating it forward.
  const licenses = getStore('scwp-licenses');
  const legacy = getStore('lv-licenses');
  const entry = await licenses.getWithMetadata(key, { type: 'json' });
  let license = entry && entry.data;
  let etag = entry && entry.etag;
  if (!license) { license = await legacy.get(key, { type: 'json' }); etag = undefined; }

  if (!license) {
    return json(404, { valid: false, reason: 'License key no longer exists.' });
  }
  if (license.revoked) {
    return json(403, { valid: false, reason: 'This license has been revoked.' });
  }

  const devices = Array.isArray(license.devices) ? license.devices : [];
  const device = devices.find((d) => d.deviceId === deviceId);

  if (!device) {
    return json(403, { valid: false, reason: 'This device is no longer authorized.' });
  }

  // Refresh lastSeen — but only when it has gone stale, so we don't write a blob on every launch.
  // The write is conditional (onlyIfMatch / onlyIfNew) so it can never clobber a concurrent activate
  // that just registered a new device; if it races (modified:false) we simply skip the refresh, which
  // is harmless. setJSON returns {modified:false} on a failed condition rather than throwing.
  const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours
  const last = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  if (!last || Number.isNaN(last) || (Date.now() - last) > REFRESH_MS) {
    device.lastSeen = new Date().toISOString();
    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    try { await licenses.setJSON(key, license, writeOpts); } catch (_) {}
  }

  return json(200, { valid: true });
};

export const config = { path: '/.netlify/functions/validate' };
