// /api/send-otp.js — Vercel Serverless Function
//
// Shared OTP-send step, used by two different features on the site:
//   1. The Lucky Spin (purpose: 'spin')
//   2. Customer account login / change-number (purpose: 'login' or
//      'change-number')
//
// MIGRATED FROM MSG91 → FAST2SMS (Dev API, route=otp).
//
// Why: MSG91's OTP widget required DLT registration (Sender ID + approved
// content template), which in turn required GST/business documents we
// don't have. Fast2SMS's plain Dev API OTP route (route=otp) sends via a
// generic/international sender ID and needs NO DLT entity, NO GST, NO
// business documents — just an account and an API key.
//
// The trade-off: unlike MSG91 (and unlike Fast2SMS's own "Smart OTP"
// feature, which DOES require DLT), this route only SENDS an SMS — it
// does not generate or verify the code for us. So we now generate the
// OTP ourselves, store a salted HMAC hash of it in Supabase
// (otp_verifications table) with a short expiry, and check it ourselves
// in verify-otp.js. Fast2SMS never sees or stores the "real" OTP value
// beyond delivering the SMS.
//
// Required environment variables:
//   FAST2SMS_API_KEY          — Fast2SMS dashboard → Dev API → API Key tab
//   OTP_TOKEN_SECRET           — same secret used everywhere else in the
//                                 OTP/session system (verify-otp.js,
//                                 complete-spin.js, customer/_tokens.js).
//                                 Now also used to hash OTPs at rest.
//   SUPABASE_SERVICE_ROLE_KEY — needed here now (previously send-otp.js
//                                only used the public anon key) because
//                                we write the generated OTP's hash into
//                                Supabase. NEVER expose this to the
//                                browser.
//
// Removed (no longer used anywhere): MSG91_AUTH_KEY, MSG91_OTP_TEMPLATE_ID.
//
// Requires a Supabase table (see accompanying SQL / setup notes):
//   otp_verifications (
//     mobile_number text not null,
//     purpose text not null,
//     otp_hash text not null,
//     expires_at timestamptz not null,
//     created_at timestamptz not null default now(),
//     attempts int not null default 0,
//     unique (mobile_number, purpose)
//   )

const crypto = require('crypto');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CQawBi0OPWWHKBIUnHr1Dg_OK4cuKIh';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const OTP_TOKEN_SECRET = process.env.OTP_TOKEN_SECRET;

const OTP_TTL_MS = 5 * 60 * 1000;       // OTP valid for 5 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;   // 1 request per phone+purpose per 60s

function todayDateStr() {
  // Keep this in sync with the front-end's todayDateStr() (IST calendar day)
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
}

function generateOtp() {
  // 6-digit numeric OTP, zero-padded (e.g. "042817")
  return String(Math.floor(100000 + Math.random() * 900000));
}

// Keep this identical to the one in verify-otp.js — both must derive the
// same hash from the same inputs or every OTP will fail verification.
function hashOtp(phone, purpose, otp) {
  return crypto.createHmac('sha256', OTP_TOKEN_SECRET)
    .update(`${phone}.${purpose}.${otp}`)
    .digest('hex');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!FAST2SMS_API_KEY || !OTP_TOKEN_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
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

  const serviceHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  if (purpose === 'spin') {
    const today = todayDateStr();
    // Already spun today? Don't send an OTP at all — tell the client so it
    // can jump straight to the "already spun" view. (Read-only, anon key
    // is fine here — same as before.)
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

  // --- Resend cooldown + fetch any existing row for this phone+purpose ---
  let existingOtpRow = null;
  try {
    const existingOtpResp = await fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?mobile_number=eq.${phone}&purpose=eq.${purpose}&select=*&limit=1`,
      { headers: serviceHeaders }
    );
    if (existingOtpResp.ok) {
      const rows = await existingOtpResp.json();
      existingOtpRow = rows && rows[0] ? rows[0] : null;
    }
  } catch (e) {
    // Non-fatal — worst case we skip the cooldown check below.
  }

  if (existingOtpRow) {
    const createdAtMs = new Date(existingOtpRow.created_at).getTime();
    if (Date.now() - createdAtMs < RESEND_COOLDOWN_MS) {
      res.statusCode = 429;
      return res.json({ error: 'Please wait a moment before requesting another OTP.' });
    }
  }

  // --- Generate, hash, and upsert the new OTP ---
  const otp = generateOtp();
  const otpHash = hashOtp(phone, purpose, otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  try {
    const upsertResp = await fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?on_conflict=mobile_number,purpose`,
      {
        method: 'POST',
        headers: { ...serviceHeaders, Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({
          mobile_number: phone,
          purpose,
          otp_hash: otpHash,
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
          attempts: 0
        })
      }
    );
    if (!upsertResp.ok) {
      res.statusCode = 502;
      return res.json({ error: 'Could not start OTP verification. Please try again.' });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not start OTP verification. Please try again.' });
  }

  // --- Send the SMS via Fast2SMS's no-DLT OTP route ---
  try {
    const smsUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${encodeURIComponent(FAST2SMS_API_KEY)}` +
      `&route=otp&variables_values=${encodeURIComponent(otp)}&numbers=${encodeURIComponent(phone)}`;
    const smsResp = await fetch(smsUrl, { method: 'GET' });
    const smsBody = await smsResp.json().catch(() => ({}));
    if (!smsResp.ok || smsBody.return !== true) {
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
