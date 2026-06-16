// ═══════════════════════════════════════════════════════════
//  MAXIMUS PRO (SCWP V6) · zipcity.js
//  ZIP code → city/state, for autofilling the Customer Info card.
//  GET /.netlify/functions/zipcity?zip=91765
//  →  { ok:true, city:"Diamond Bar", state:"CA" }
//     { ok:false, reason }
//  Same-origin proxy (so the browser never makes a cross-origin call →
//  no CORS, no CSP allowlist change). Online-only; the app falls back
//  to manual entry on any failure.
// ═══════════════════════════════════════════════════════════

// ── CONFIG (swap here if the upstream source ever changes) ──
const ZIP_API = 'https://api.zippopotam.us/us/';   // free, no API key required

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=604800',   // ZIP→city is effectively static — cache a week
    },
  });
}

async function fetchJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ms || 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const zip = (url.searchParams.get('zip') || '').trim();
  if (!/^\d{5}$/.test(zip)) return json(400, { ok: false, reason: 'Invalid ZIP' });

  const d = await fetchJSON(ZIP_API + zip, 6000);
  const place = d && Array.isArray(d.places) && d.places[0];
  if (!place) return json(200, { ok: false, reason: 'ZIP not found' });

  return json(200, {
    ok: true,
    city: place['place name'] || '',
    state: place['state abbreviation'] || '',
  });
};

export const config = { path: '/.netlify/functions/zipcity' };
