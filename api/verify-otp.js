// /api/verify-otp.js — Vercel Serverless Function
//
// Step 2 of the OTP-gated flows (Lucky Spin, login, change-number).
//
// MIGRATED FROM MSG91 → FAST2SMS (Dev API, route=otp).
//
// MSG91 used to verify the code server-side on MSG91's end (we just
// forwarded phone+otp to their /otp/verify endpoint). Fast2SMS's plain
// Dev API OTP route doesn't offer that — it only sends the SMS — so this
// function now does the verification itself: it looks up the salted HMAC
// hash that send-otp.js stored in Supabase, hashes the code the user
// typed the same way, and compares them with a timing-safe check.
//
// On success it issues the SAME short-lived signed token as before —
// login.js, change-number.js, complete-spin.js and customer/_tokens.js
// are UNCHANGED, since the token format (phone.expiresAt.sig, HMAC'd with
// OTP_TOKEN_SECRET) is identical to what this file produced under MSG91.
//
// Required environment variables:
//   OTP_TOKEN_SECRET          — same secret used everywhere else
//   SUPABASE_SERVICE_ROLE_KEY — needed here now (previously verify-otp.js
//                                didn't talk to Supabase at all) to read
//                                and clear the stored OTP hash.
//
// Removed (no longer used anywhere): MSG91_AUTH_KEY.

const crypto = require('crypto');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const OTP_TOKEN_SECRET = process.env.OTP_TOKEN_SECRET;
const TOKEN_TTL_MS = 5 * 60 * 1000; // token is valid 5 minutes after OTP verification
const MAX_ATTEMPTS = 5;             // wrong guesses allowed before the OTP is invalidated

function signToken(phone, expiresAt) {
  const payload = `${phone}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

// Must stay identical to the one in send-otp.js — both must derive the
// same hash from the same inputs or every OTP will fail verification.
function hashOtp(phone, purpose, otp) {
  return crypto.createHmac('sha256', OTP_TOKEN_SECRET)
    .update(`${phone}.${purpose}.${otp}`)
    .digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!OTP_TOKEN_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
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
  const otp = String(body.otp || '').trim();
  const purpose = String(body.purpose || 'spin'); // must match what send-otp.js was called with

  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid phone number.' });
  }
  if (!/^\d{4,6}$/.test(otp)) {
    res.statusCode = 400;
    return res.json({ error: 'Please enter the OTP.' });
  }

  const serviceHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  let record;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?mobile_number=eq.${phone}&purpose=eq.${purpose}&select=*&limit=1`,
      { headers: serviceHeaders }
    );
    const rows = resp.ok ? await resp.json() : [];
    record = rows && rows[0];
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not verify OTP right now. Please try again.' });
  }

  if (!record) {
    res.statusCode = 401;
    return res.json({ error: 'No OTP request found for this number. Please request a new OTP.' });
  }

  if (Date.now() > new Date(record.expires_at).getTime()) {
    // Clean up the expired row so a retry gets a clean slate.
    fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?mobile_number=eq.${phone}&purpose=eq.${purpose}`,
      { method: 'DELETE', headers: serviceHeaders }
    ).catch(() => {});
    res.statusCode = 401;
    return res.json({ error: 'This OTP has expired. Please request a new one.' });
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    res.statusCode = 401;
    return res.json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
  }

  const expectedHash = hashOtp(phone, purpose, otp);
  const isMatch = record.otp_hash.length === expectedHash.length && safeEqual(record.otp_hash, expectedHash);

  if (!isMatch) {
    // Best-effort attempt counter — a failed increment here just means the
    // MAX_ATTEMPTS cap is slightly softer, not a security hole.
    fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?mobile_number=eq.${phone}&purpose=eq.${purpose}`,
      {
        method: 'PATCH',
        headers: serviceHeaders,
        body: JSON.stringify({ attempts: (record.attempts || 0) + 1 })
      }
    ).catch(() => {});
    res.statusCode = 401;
    return res.json({ error: 'Incorrect or expired OTP. Please try again.' });
  }

  // Correct OTP — single-use, so delete the row before issuing the token.
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/otp_verifications?mobile_number=eq.${phone}&purpose=eq.${purpose}`,
      { method: 'DELETE', headers: serviceHeaders }
    );
  } catch (e) {
    // Non-fatal: worst case the row lingers until it naturally expires and
    // is overwritten by the next send-otp.js call for this phone+purpose.
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = signToken(phone, expiresAt);

  res.statusCode = 200;
  return res.json({ token, expiresAt });
};
