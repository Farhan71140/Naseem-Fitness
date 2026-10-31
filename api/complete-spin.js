// /api/complete-spin.js — Vercel Serverless Function
//
// The Lucky Spin endpoint, and the actual security boundary.
//
// Members only: the phone number must belong to a registered customer
// (someone who signed up with name + mobile — no OTP). The reward is picked
// server-side using REWARD_WEIGHTS and written with the service-role key,
// so the browser can never choose a reward or insert into `lucky_spins`
// directly, and one number can only spin once per IST day.
//
// Required environment variables:
//   SUPABASE_SERVICE_ROLE_KEY — Supabase → Project Settings → API →
//                                service_role key. NEVER expose this to the
//                                browser; it bypasses Row Level Security.
//
// No longer needed here: OTP_TOKEN_SECRET.

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CQawBi0OPWWHKBIUnHr1Dg_OK4cuKIh';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Table + column that store signed-up customers (the ones /api/customer/login
// creates). If yours are named differently, change these two lines.
const CUSTOMERS_TABLE = 'customers';
const CUSTOMERS_PHONE_COLUMN = 'mobile_number';

// Keep in sync with the DEFAULT_REWARD_CATALOG / REWARD_WEIGHTS in index.html.
// If you change the odds or catalog in one place, change it in both, or
// better: move both to a shared config the client fetches instead of
// hardcoding — this duplication is the main maintenance risk of this file.
const DEFAULT_REWARD_CATALOG = [
  { id: 'shaker', emoji: '🥤', label: 'Shaker Bottle', type: 'free_item', value: null },
  { id: 'fishoil', emoji: '🐟', label: 'Fish Oil 1000mg', type: 'free_item', value: null },
  { id: 'creatine', emoji: '💪', label: 'Creatine', type: 'free_item', value: null },
  { id: 'keychain', emoji: '🔑', label: 'Keychain', type: 'free_item', value: null },
  { id: 'surprise', emoji: '🎁', label: 'Surprise Gift', type: 'free_item', value: null },
  { id: 'off50', emoji: '💰', label: '₹50 OFF', type: 'discount', value: 50 },
  { id: 'off100', emoji: '💰', label: '₹100 OFF', type: 'discount', value: 100 }
];
const REWARD_WEIGHTS = {
  keychain: 50, off50: 20, off100: 20, creatine: 4, fishoil: 2, surprise: 2, shaker: 2
};

function todayDateStr() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
}

function pickWeightedWinner(catalog) {
  const weights = catalog.map(r => REWARD_WEIGHTS[r.id] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return catalog[i];
  }
  return catalog[catalog.length - 1];
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    res.statusCode = 500;
    return res.json({ error: 'Spin service is not configured yet. Please contact support.' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  const phone = String(body.phone || '').trim();

  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid phone number.' });
  }
  const today = todayDateStr();
  const serviceHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  // Must be a registered customer — anyone who hasn't signed up is turned away.
  try {
    const custResp = await fetch(
      `${SUPABASE_URL}/rest/v1/${CUSTOMERS_TABLE}?${CUSTOMERS_PHONE_COLUMN}=eq.${phone}&select=${CUSTOMERS_PHONE_COLUMN}&limit=1`,
      { headers: serviceHeaders }
    );
    if (!custResp.ok) {
      console.error('complete-spin: customer lookup failed', custResp.status, await custResp.text().catch(() => ''));
      res.statusCode = 502;
      return res.json({ error: 'Could not verify your account. Please try again.' });
    }
    const custRows = await custResp.json();
    if (!custRows || !custRows[0]) {
      res.statusCode = 403;
      return res.json({ error: 'Please sign up first to use the Lucky Spin.', needsSignup: true });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not verify your account. Please try again.' });
  }

  // Re-check "already spun today" right before writing — the earlier check
  // in send-otp.js was only a courtesy to save an SMS, not a guarantee.
  try {
    const existingResp = await fetch(
      `${SUPABASE_URL}/rest/v1/lucky_spins?mobile_number=eq.${phone}&spin_date=eq.${today}&select=*&limit=1`,
      { headers: serviceHeaders }
    );
    if (existingResp.ok) {
      const rows = await existingResp.json();
      if (rows && rows[0]) {
        res.statusCode = 200;
        return res.json({ alreadySpun: true, record: rows[0] });
      }
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not check today\u2019s spin status. Please try again.' });
  }

  // Load the live catalog (falls back to the default if Supabase/table is empty)
  let catalog = DEFAULT_REWARD_CATALOG;
  try {
    const catResp = await fetch(
      `${SUPABASE_URL}/rest/v1/lucky_rewards_catalog?enabled=eq.true&select=*&order=sort_order.asc`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (catResp.ok) {
      const rows = await catResp.json();
      if (rows && rows.length) catalog = rows;
    }
  } catch (e) {
    // fall back to DEFAULT_REWARD_CATALOG
  }

  const winner = pickWeightedWinner(catalog);

  try {
    const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/lucky_spins`, {
      method: 'POST',
      headers: { ...serviceHeaders, Prefer: 'return=representation' },
      body: JSON.stringify({
        mobile_number: phone,
        spin_date: today,
        reward_id: winner.id,
        reward_emoji: winner.emoji,
        reward_label: winner.label,
        reward_type: winner.type,
        reward_value: winner.value,
        status: 'active'
      })
    });

    if (!insertResp.ok) {
      // Most likely a duplicate-spin race against the unique constraint on
      // (mobile_number, spin_date) — treat as already-used rather than a hard error.
      const raceResp = await fetch(
        `${SUPABASE_URL}/rest/v1/lucky_spins?mobile_number=eq.${phone}&spin_date=eq.${today}&select=*&limit=1`,
        { headers: serviceHeaders }
      );
      const raceRows = raceResp.ok ? await raceResp.json() : [];
      if (raceRows && raceRows[0]) {
        res.statusCode = 200;
        return res.json({ alreadySpun: true, record: raceRows[0] });
      }
      res.statusCode = 502;
      return res.json({ error: 'Could not record your spin. Please try again.' });
    }

    const inserted = await insertResp.json();
    res.statusCode = 200;
    return res.json({ reward: inserted[0] || inserted });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not record your spin. Please try again.' });
  }
};
