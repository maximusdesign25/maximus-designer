// ═══════════════════════════════════════════════════════════
//  MAXIMUS PRO · crm-writeback.js
//  Writes a finished SCWP quote back into the shared Maximus CRM
//  (Supabase). Runs SERVER-SIDE with the service-role key, so reps
//  never log into Supabase and the key is never exposed to the browser.
//
//  Body: { leadId, quoteId, quoteNum, customer, scwpStatus, total, items, rep, soldDate }
//  Response: { ok:true, id:<quote uuid> }  — id lets the client update the same row next time.
//
//  Env (set in Netlify → Site settings → Environment variables):
//    SUPABASE_URL                = https://<project>.supabase.co
//    SUPABASE_SERVICE_ROLE_KEY   = <service_role secret key>   (server-only; never VITE_/public)
//  Missing env → 501 + the app silently stays device-only. Safe in local `netlify dev`.
// ═══════════════════════════════════════════════════════════
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const SB_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// SCWP quote status  ->  CRM quotes.status / leads.stage
const STATUS_MAP = { '': 'Draft', new: 'Draft', presented: 'Presented', followup: 'Presented', sold: 'Sold', lost: 'Lost' };
const STAGE_MAP = { presented: 'Estimate Sent', followup: 'Estimate Sent', sold: 'Won', lost: 'Lost' };

async function sb(path, method, body, prefer) {
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (_) { data = txt; }
  if (!r.ok) throw new Error('Supabase ' + r.status + ': ' + String(txt).slice(0, 200));
  return data;
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false, error: 'Method not allowed' });
  if (!SB_URL || !SB_KEY) return json(501, { ok: false, error: 'Cloud not configured' });

  let b;
  try { b = await req.json(); } catch { return json(400, { ok: false, error: 'Invalid body' }); }

  const scwp = String(b.scwpStatus || '');
  const row = {
    lead_id: b.leadId || null,
    quote_num: b.quoteNum || null,
    customer: b.customer || '',
    status: STATUS_MAP[scwp] || 'Draft',
    total: Number(b.total) || 0,
    items: Array.isArray(b.items) ? b.items : [],
    rep: b.rep || '',
    sold_date: b.soldDate || null,
  };

  try {
    // 1) Upsert the quote row (idempotent: PATCH if we already have its id, else INSERT).
    let id = b.quoteId || null;
    if (id) {
      const upd = await sb('/quotes?id=eq.' + encodeURIComponent(id), 'PATCH', row, 'return=representation');
      if (!Array.isArray(upd) || !upd.length) id = null; // row vanished → fall through to insert
    }
    if (!id) {
      const ins = await sb('/quotes', 'POST', row, 'return=representation');
      id = Array.isArray(ins) && ins[0] ? ins[0].id : null;
    }

    // 2) Reflect the quote on the linked CRM lead so the round-trip is visible in the pipeline:
    //    value follows the real quote total; stage advances on presented / won on sold / lost on lost.
    if (b.leadId) {
      const patch = { value: Number(b.total) || 0 };
      if (STAGE_MAP[scwp]) patch.stage = STAGE_MAP[scwp];
      try { await sb('/leads?id=eq.' + encodeURIComponent(b.leadId), 'PATCH', patch); } catch (_) {}
    }

    return json(200, { ok: true, id });
  } catch (e) {
    return json(502, { ok: false, error: String((e && e.message) || e) });
  }
};

export const config = { path: '/.netlify/functions/crm-writeback' };
