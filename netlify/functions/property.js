// ═══════════════════════════════════════════════════════════
//  MAXIMUS PRO (SCWP V6) · property.js
//  Property info lookup for a customer address, via the Rentcast API.
//  Replaces the old Redfin scrape, which Redfin/CloudFront blocks from
//  datacenter IPs (403). Rentcast is a legitimate, server-friendly API.
//
//    GET /.netlify/functions/property?addr=809 Bridle Dr&city=Diamond Bar&state=CA&zip=91765
//    → { ok:true, address, yearBuilt, beds, baths, sqFt, lotSqFt, stories,
//         propertyType, lastSoldPrice, lastSoldDate(ms), estValue }
//      { ok:false, reason }
//
//  SETUP: set the env var RENTCAST_API_KEY (or PROPERTY_API_KEY — both accepted)
//         in Netlify (Site settings → Environment variables), then redeploy.
//         Without it this returns a clean "not set up yet" message and the app
//         falls back to manual entry.
//
//  QUOTA: each lookup makes up to 2 Rentcast calls (records + value estimate).
//         Set INCLUDE_AVM = false below to halve usage (drops the Est. Value).
//
//  Returns the SAME response shape the app already expects, so no UI change.
//  Same-origin proxy (no CORS / no CSP allowlist change). Online-only;
//  the app falls back gracefully on any failure.
// ═══════════════════════════════════════════════════════════

const API_BASE = 'https://api.rentcast.io/v1';
const INCLUDE_AVM = true;   // false → skip the value-estimate call (halves monthly API usage)

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
  });
}

// Call a Rentcast endpoint. Returns { status, data, text } (data null if not JSON;
// text = first 300 chars of the raw body, for diagnostics).
async function rc(path, key, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ms || 9000);
  try {
    const r = await fetch(API_BASE + path, {
      signal: ctrl.signal,
      headers: { 'X-Api-Key': key, 'Accept': 'application/json' },
    });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch (_) {}
    return { status: r.status, data, text: (text || '').slice(0, 300) };
  } catch (e) {
    return { status: 0, data: null, text: String((e && e.message) || e) };
  } finally {
    clearTimeout(t);
  }
}

const num = (v) => { if (v == null) return null; const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
const toMs = (v) => { if (!v) return null; const t = Date.parse(v); return isNaN(t) ? null : t; };   // ISO date → ms (the app formats lastSoldDate via new Date(Number(ts)))

export default async (req) => {
  const u = new URL(req.url);
  const addr = (u.searchParams.get('addr') || '').trim();
  const city = (u.searchParams.get('city') || '').trim();
  const state = (u.searchParams.get('state') || 'CA').trim();
  const zip = (u.searchParams.get('zip') || '').trim();
  if (!addr) return json(400, { ok: false, reason: 'No address' });

  const key = process.env.RENTCAST_API_KEY || process.env.PROPERTY_API_KEY;   // accept either name
  if (!key) return json(200, { ok: false, reason: 'Property lookup not set up yet' });   // env var missing → graceful

  const query = [addr, city, state, zip].filter(Boolean).join(', ');
  const qAddr = 'address=' + encodeURIComponent(query);

  // 1) property records  (+ 2) value estimate — in parallel
  const calls = [rc('/properties?' + qAddr, key, 9000)];
  if (INCLUDE_AVM) calls.push(rc('/avm/value?' + qAddr, key, 9000));
  const [recRes, avmRes] = await Promise.all(calls);

  // Diagnostics: ?debug=1 returns the raw Rentcast status + body snippet for both calls.
  // (Does not leak the key — only whether one is present and its length.)
  if (u.searchParams.get('debug') === '1') {
    return json(200, { ok: false, debug: {
      query,
      keyPresent: !!key, keyLen: key ? key.length : 0,
      records: { status: recRes.status, body: recRes.text },
      avm: avmRes ? { status: avmRes.status, body: avmRes.text } : null,
    } });
  }

  // Surface auth / quota problems clearly (Rentcast may use 401 OR 403 for a bad/missing key)
  if (recRes.status === 401 || recRes.status === 403) return json(200, { ok: false, reason: 'Property lookup auth failed (status ' + recRes.status + ') — check the API key' });
  if (recRes.status === 429) return json(200, { ok: false, reason: 'Property lookup limit reached for this month' });
  if (recRes.status !== 200) return json(200, { ok: false, reason: 'Property lookup error (Rentcast status ' + recRes.status + ')' });

  // /properties returns an array (filtered by address) — take the first match.
  const rec = Array.isArray(recRes.data) ? recRes.data[0] : recRes.data;
  if (!rec || typeof rec !== 'object') return json(200, { ok: false, reason: 'Property records not found' });

  const out = { ok: true, address: rec.formattedAddress || query };
  if (rec.yearBuilt != null) out.yearBuilt = rec.yearBuilt;
  if (rec.bedrooms != null) out.beds = rec.bedrooms;
  if (rec.bathrooms != null) out.baths = rec.bathrooms;
  const sf = num(rec.squareFootage); if (sf != null) out.sqFt = sf;
  const lot = num(rec.lotSize); if (lot != null) out.lotSqFt = lot;
  if (rec.propertyType) out.propertyType = rec.propertyType;
  const floors = rec.features && rec.features.floorCount; if (floors != null) out.stories = floors;
  const lsp = num(rec.lastSalePrice); if (lsp != null) out.lastSoldPrice = lsp;
  const lsd = toMs(rec.lastSaleDate); if (lsd != null) out.lastSoldDate = lsd;

  if (INCLUDE_AVM && avmRes && avmRes.data) {
    const est = num(avmRes.data.price); if (est != null) out.estValue = est;
  }

  return json(200, out);
};

export const config = { path: '/.netlify/functions/property' };
