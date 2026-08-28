// /api/send-otp.js — Vercel Serverless Function
//
// Shared OTP-send step, used by two different features on the site:
//   1. The Lucky Spin (purpose: 'spin')
//   2. Customer account login / change-number (purpose: 'login' or
//      'change-number')
// Texts a one-time code to the phone number via MSG91's OTP API.
//
// Required environment variables (set in Vercel Project Settings → Environment
// Variables — NEVER hardcode these in the repo):
//   MSG91_AUTH_KEY     — from MSG91 dashboard → API → Auth Key
//   MSG91_OTP_TEMPLATE_ID — the DLT-approved OTP SMS template id you create
//                            in MSG91 (Campaigns → OTP → your template)
//
// Uses the same Supabase project as the rest of the site (public anon key,
// read-only here) purely to check "has this number already spun today?" —
// but ONLY for purpose:'spin' — so we don't burn an SMS on a number that
// couldn't spin again anyway. Login/change-number requests skip that check
// entirely since it doesn't apply to them.

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CQawBi0OPWWHKBIUnHr1Dg_OK4cuKIh';

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_OTP_TEMPLATE_ID = process.env.MSG91_OTP_TEMPLATE_ID;

function todayDateStr() {
  // Keep this in sync with the front-end's todayDateStr() (IST calendar day)
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!MSG91_AUTH_KEY || !MSG91_OTP_TEMPLATE_ID) {
    res.statusCode = 500;
    return res.json({ error: 'OTP service is not configured yet. Please contact support.' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  const phone = String(body.phone || '').trim();
  const purpose = String(body.purpose || 'spin'); // 'spin' | 'login' | 'change-number'
  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Please enter a valid 10-digit mobile number.' });
  }

  if (purpose === 'spin') {
    const today = todayDateStr();
    // Already spun today? Don't send an OTP at all — tell the client so it
    // can jump straight to the "already spun" view.
    try {
      const existingResp = await fetch(
        `${SUPABASE_URL}/rest/v1/lucky_spins?mobile_number=eq.${phone}&spin_date=eq.${today}&select=*&limit=1`,
        { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
      );
      if (existingResp.ok) {
        const rows = await existingResp.json();
        if (rows && rows[0]) {
          res.statusCode = 200;
          return res.json({ alreadySpun: true, record: rows[0] });
        }
      }
    } catch (e) {
      // If this check fails, fall through and still send the OTP — the
      // authoritative "already spun" check happens again in complete-spin.js
      // right before the reward is written, so this is a best-effort saving,
      // not a security boundary.
    }
  }

  // MSG91 mobile format: country code + number, no leading zero/plus
  const mobileWithCode = `91${phone}`;

  try {
    const msgResp = await fetch(
      `https://control.msg91.com/api/v5/otp?template_id=${encodeURIComponent(MSG91_OTP_TEMPLATE_ID)}&mobile=${mobileWithCode}&otp_expiry=5`,
      { method: 'POST', headers: { authkey: MSG91_AUTH_KEY, 'Content-Type': 'application/json' } }
    );
    const msgBody = await msgResp.json().catch(() => ({}));
    if (!msgResp.ok || msgBody.type === 'error') {
      res.statusCode = 502;
      return res.json({ error: 'Could not send OTP right now. Please try again in a moment.' });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not send OTP right now. Please try again in a moment.' });
  }

  res.statusCode = 200;
  return res.json({ sent: true });
};
