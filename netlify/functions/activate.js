// ═══════════════════════════════════════════════════════════
//  LV V2.3 · activate.js
//  Registers a device against a license key (up to MAX_DEVICES).
//  Body: { key, deviceId, deviceLabel }
//  Response: { success: true } OR { success: false, reason }
// ═══════════════════════════════════════════════════════════
import { getStore } from '@netlify/blobs';

const MAX_DEVICES = 3;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { success: false, reason: 'Method not allowed' });

  let body;
  try { body = await req.json(); }
  catch { return json(400, { success: false, reason: 'Invalid request body' }); }

  const key = String(body.key || '').trim().toUpperCase();
  const deviceId = String(body.deviceId || '').trim();
  const deviceLabel = String(body.deviceLabel || 'Unknown Device').trim().slice(0, 80);

  if (!key) return json(400, { success: false, reason: 'License key required' });
  if (!deviceId) return json(400, { success: false, reason: 'Device ID required' });

  // Store renamed lv-licenses → scwp-licenses. New store is authoritative; legacy is read-only fallback.
  const licenses = getStore('scwp-licenses');
  const legacy = getStore('lv-licenses');

  // Compare-and-swap loop. Two devices activating at once could otherwise both read
  // "2 devices", both write, and overshoot the limit. onlyIfMatch makes each write
  // fail if the blob changed since we read it; on failure we re-read and retry.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = await licenses.getWithMetadata(key, { type: 'json' });
    let license = entry && entry.data;
    let etag = entry && entry.etag;

    if (!license) {
      // Fall back to the legacy store. A migrated license has no etag in the new store, so the
      // first write uses onlyIfNew (see writeOpts below) to migrate it forward; if another request
      // races us and creates it first, that write reports modified:false and we re-read for the etag.
      const old = await legacy.get(key, { type: 'json' });
      if (old) { license = old; etag = undefined; }
    }
    if (!license) {
      return json(404, { success: false, reason: 'Invalid license key.' });
    }
    if (license.revoked) {
      return json(403, { success: false, reason: 'This license has been revoked. Contact the owner.' });
    }

    const devices = Array.isArray(license.devices) ? license.devices : [];
    const maxDevices = typeof license.maxDevices === 'number' ? license.maxDevices : MAX_DEVICES;
    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };

    // Is this device already registered? Refresh its lastSeen and return success.
    const existing = devices.find((d) => d.deviceId === deviceId);
    if (existing) {
      existing.lastSeen = new Date().toISOString();
      existing.deviceLabel = deviceLabel || existing.deviceLabel;
      license.devices = devices;
      const res = await licenses.setJSON(key, license, writeOpts);
      if (res && res.modified === false) continue; // raced — re-read and retry
      return json(200, { success: true, reason: 'Device already registered.' });
    }

    // New device — check capacity.
    if (devices.length >= maxDevices) {
      return json(403, {
        success: false,
        reason: `Device limit reached (${devices.length}/${maxDevices}). Contact the owner to free up a slot.`,
      });
    }

    // Register the new device.
    const now = new Date().toISOString();
    devices.push({ deviceId, deviceLabel, activatedAt: now, lastSeen: now });
    license.devices = devices;
    const res = await licenses.setJSON(key, license, writeOpts);
    if (res && res.modified === false) continue; // raced — re-read and re-check capacity
    return json(200, { success: true });
  }

  return json(409, { success: false, reason: 'Activation is busy — please try again in a moment.' });
};

export const config = { path: '/.netlify/functions/activate' };
