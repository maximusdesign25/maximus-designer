// ═══════════════════════════════════════════════════════════
//  MAXIMUS PRO (SCWP V6) · firezone.js
//  Decide whether a customer address requires tempered glazing
//  (CA Chapter 7A / WUI). ADVISORY ONLY — never a legal determination.
//
//  GET /.netlify/functions/firezone?addr=<street>&city=<city>&state=<st>&zip=<zip>
//     (also accepts a one-line ?address= for the geocode fallback)
//  →  { ok:true, temper:bool, zone, sra:bool, label, method, lat, lng }
//     { ok:false, reason }
//
//  Lookup strategy (all FREE, no API key, no credit card):
//   1) PARCEL by address text — CAL FIRE's statewide parcel layer. Returns the
//      actual property lot's centroid → rooftop-accurate, no geocoder needed.
//   2) FALLBACK: US Census geocoder (street-centerline) + 75 m buffer if the
//      exact point misses. Fails SAFE toward tempering.
//  Empty/error responses are retried once (these layers throttle intermittently).
//  All endpoints live in the CONFIG block below — the only maintenance point.
// ═══════════════════════════════════════════════════════════

// ── CONFIG ──
const GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
// CAL FIRE's OWN org. Parcel layer = statewide property lots (address-searchable, returnCentroid).
const PARCELS  = 'https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/CA_Statewide_Parcels_Public_view/FeatureServer/0';
// Official statewide FHSZ layers (same ones the OSFM viewer uses). SRA eff. 2024; LRA recommended 2025.
const FHSZ_LAYERS = [
  'https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/FHSZSRA_23_3/FeatureServer/0',      // State Responsibility Area
  'https://services1.arcgis.com/jUJYIo9tSA7EHvfZ/arcgis/rest/services/FHSALRA25_v1_All/FeatureServer/0',  // Local Responsibility Area
];
const HAZ_FIELD = 'FHSZ_Description';   // "Very High" | "High" | "Moderate"
const RANK = { 'Very High': 3, 'High': 2, 'Moderate': 1 };
const BUFFER_M = 75;

// Street suffixes / directionals to strip so the parcel street-name LIKE matches the layer's SITE_STREET_NAME.
const SUFFIXES = new Set(['ST','STREET','AVE','AVENUE','RD','ROAD','DR','DRIVE','LN','LANE','BLVD','BOULEVARD','CT','COURT','PL','PLACE','WAY','CIR','CIRCLE','TER','TERRACE','TRL','TRAIL','PKWY','PARKWAY','HWY','HIGHWAY','CYN','CANYON','PT','POINT','SQ','SQUARE','LOOP','RUN','PASS','PATH','WALK','ROW','BND','BEND','XING','CROSSING','CV','COVE','GLN','GLEN','KNL','KNOLL','VW','VIEW','RDG','RIDGE','GRV','GROVE','MNR','MANOR','PLZ','PLAZA']);
const DIRS = new Set(['N','S','E','W','NE','NW','SE','SW','NORTH','SOUTH','EAST','WEST']);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

async function fetchJSON(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, ms || 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    if (j && j.error) return null;   // ArcGIS often returns 200 + {error} when throttled/invalid → treat as a miss
    return j;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// One retry — these CAL FIRE layers intermittently throttle (a single empty/error is unreliable).
async function fetchJSONRetry(url, ms) {
  let r = await fetchJSON(url, ms);
  if (r) return r;
  await new Promise((res) => setTimeout(res, 250));
  return await fetchJSON(url, ms);
}

// "809 N Bridle Dr" → { house:'809', street:'BRIDLE' }
function parseStreet(line) {
  const t = String(line || '').trim().toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (!t.length) return null;
  let house = '';
  if (/^\d+[A-Z]?$/.test(t[0])) { house = t[0]; t.shift(); }
  if (t.length > 1 && DIRS.has(t[0])) t.shift();                 // leading directional
  while (t.length > 1 && SUFFIXES.has(t[t.length - 1])) t.pop(); // trailing suffix(es)
  while (t.length > 1 && DIRS.has(t[t.length - 1])) t.pop();     // trailing directional
  return { house, street: t.join(' ').trim() };
}

const sqlEsc = (s) => String(s || '').replace(/'/g, "''");
// For LIKE operands: also neutralize the % and _ wildcards (and backslash) so a street/city name that
// happens to contain one matches literally instead of as a wildcard. Pair with ESCAPE '\' on the clause.
const likeEsc = (s) => sqlEsc(s).replace(/[\\%_]/g, (m) => '\\' + m);

// Method 1 — look the address up in the parcel layer; return the lot centroid (rooftop-accurate).
async function parcelPoint(house, street, city, zip) {
  if (!street) return null;
  const where = [];
  if (house) where.push("SITE_HOUSE_NUMBER='" + sqlEsc(house) + "'");
  where.push("SITE_STREET_NAME LIKE '" + likeEsc(street) + "%' ESCAPE '\\'");
  if (city) where.push("SITE_CITY LIKE '" + likeEsc(city.toUpperCase()) + "%' ESCAPE '\\'");
  else if (zip) where.push("SITE_ZIP LIKE '" + likeEsc(zip) + "%' ESCAPE '\\'");
  const q = PARCELS + '/query?where=' + encodeURIComponent(where.join(' AND ')) +
    '&outFields=' + encodeURIComponent('FullStreetAddress,PARCEL_APN') +
    '&returnCentroid=true&returnGeometry=false&outSR=4326&resultRecordCount=1&f=json';
  const r = await fetchJSONRetry(q, 7000);
  const f = r && Array.isArray(r.features) && r.features[0];
  const cen = f && f.centroid;
  if (cen && typeof cen.x === 'number' && typeof cen.y === 'number') {
    return { lng: cen.x, lat: cen.y, apn: (f.attributes && f.attributes.PARCEL_APN) || '' };
  }
  return null;
}

// FHSZ point-in-polygon across SRA + LRA (optional buffer). Retries empties.
// The SRA and LRA layers are independent → query them CONCURRENTLY (Promise.all) and
// aggregate, instead of one-after-another. Cuts a full round-trip off every lookup; the
// result (highest-ranked zone + any-SRA) is identical to the old sequential scan.
async function scan(lng, lat, distanceM) {
  const buildQ = (layerUrl) => layerUrl + '/query?geometry=' + encodeURIComponent(lng + ',' + lat) +
    '&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects' +
    (distanceM ? '&distance=' + distanceM + '&units=esriSRUnit_Meter' : '') +
    '&outFields=' + encodeURIComponent(HAZ_FIELD + ',SRA') + '&returnGeometry=false&f=json';
  const results = await Promise.all(FHSZ_LAYERS.map((layerUrl) => fetchJSONRetry(buildQ(layerUrl), 7000)));
  let best = null, sra = false, responded = false;
  for (const r of results) {
    if (!r) continue;
    responded = true;
    for (const f of (Array.isArray(r.features) ? r.features : [])) {
      const a = f.attributes || {};
      const cls = a[HAZ_FIELD];
      if (a.SRA === 'SRA') sra = true;
      if (RANK[cls] && (!best || RANK[cls] > (RANK[best] || 0))) best = cls;  // ignore NonWildland/blank
    }
  }
  return { best, sra, responded };
}

export default async (req) => {
  const url = new URL(req.url);
  const addrLine = (url.searchParams.get('addr') || '').trim();
  const city = (url.searchParams.get('city') || '').trim();
  const state = (url.searchParams.get('state') || 'CA').trim();
  const zip = (url.searchParams.get('zip') || '').trim();
  const oneLine = (url.searchParams.get('address') || '').trim() ||
    [addrLine, city, state, zip].filter(Boolean).join(', ');
  if (!addrLine && !oneLine) return json(400, { ok: false, reason: 'Missing address' });

  let lng = null, lat = null, method = '', apn = '';

  // 1) PARCEL by address text (no geocoder; rooftop-accurate)
  const ps = parseStreet(addrLine || oneLine);
  if (ps && ps.street) {
    const p = await parcelPoint(ps.house, ps.street, city, zip);
    if (p) { lng = p.lng; lat = p.lat; apn = p.apn; method = 'parcel'; }
  }

  // 2) FALLBACK: Census geocode (street centerline)
  if (lng === null) {
    const g = await fetchJSON(GEOCODER + '?address=' + encodeURIComponent(oneLine) + '&benchmark=Public_AR_Current&format=json', 7000);
    const m = g && g.result && Array.isArray(g.result.addressMatches) && g.result.addressMatches[0];
    if (m && m.coordinates && typeof m.coordinates.x === 'number') { lng = m.coordinates.x; lat = m.coordinates.y; method = 'geocode'; }
  }
  if (lng === null) return json(200, { ok: false, reason: 'Address not found' });

  // 3) Zone lookup. Parcel centroid is on the lot → exact only. Geocode point may be just outside → buffer fallback.
  let { best, sra, responded } = await scan(lng, lat, 0);
  let near = false;
  if (responded && method === 'geocode' && !best && !sra) {
    const w = await scan(lng, lat, BUFFER_M);
    if (w.best || w.sra) { best = w.best; sra = w.sra; near = true; }
  }
  if (!responded) return json(200, { ok: false, reason: 'Fire-zone service unavailable' });

  // 4) Decide. Ch.7A/WUI applies across all SRA, and to LRA Very High/High → need ≥1 tempered pane. Err toward temper.
  const zone = best || (sra ? 'SRA' : 'None');
  const temper = sra || best === 'Very High' || best === 'High';
  const label = best
    ? (near ? 'Near ' : '') + best + (sra ? ' (SRA)' : ' (LRA)')
    : (sra ? 'SRA' : 'Not in a fire zone');

  return json(200, { ok: true, temper, zone, sra, near, method, apn, label, lat, lng });
};

export const config = { path: '/.netlify/functions/firezone' };
