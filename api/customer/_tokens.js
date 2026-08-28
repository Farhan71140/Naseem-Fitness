// /api/customer/_tokens.js — shared helper, not a route itself
//
// Two kinds of signed tokens are used across the customer account system,
// both HMAC-signed with OTP_TOKEN_SECRET so they can't be forged from the
// browser:
//
//  1. OTP proof token (issued by /api/verify-otp.js) — short-lived (5 min),
//     just proves "this phone received and entered the correct OTP just
//     now". Consumed once by login.js or change-number.js.
//
//  2. Session token (issued by login.js / change-number.js) — long-lived
//     (90 days), proves "this browser is logged in as customer X with
//     phone Y". Stored in the browser's localStorage and sent back on
//     every account action (view orders, change number, delete account,
//     auto-login on return visits).
//
// Both are stateless (no server-side session store) — verifying one is
// just checking its HMAC signature and expiry, same pattern as the spin
// flow's complete-spin.js.

const crypto = require('crypto');

const OTP_TOKEN_SECRET = process.env.OTP_TOKEN_SECRET;

function verifyOtpProofToken(token, phone) {
  // Matches the token shape issued by /api/verify-otp.js: phone.expiresAt.sig
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch (e) { return false; }
  const parts = decoded.split('.');
  if (parts.length !== 3) return false;
  const [tokenPhone, expiresAtStr, sig] = parts;
  if (tokenPhone !== phone) return false;
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return false;
  const expectedSig = crypto.createHmac('sha256', OTP_TOKEN_SECRET)
    .update(`${tokenPhone}.${expiresAtStr}`).digest('hex');
  return safeEqual(sig, expectedSig);
}

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function signSessionToken(customerId, phone) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${customerId}.${phone}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

// Returns { customerId, phone } if valid, or null.
function verifySessionToken(token) {
  let decoded;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); } catch (e) { return null; }
  const parts = decoded.split('.');
  if (parts.length !== 4) return null;
  const [customerId, phone, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt) return null;
  const expectedSig = crypto.createHmac('sha256', OTP_TOKEN_SECRET)
    .update(`${customerId}.${phone}.${expiresAtStr}`).digest('hex');
  if (!safeEqual(sig, expectedSig)) return null;
  return { customerId, phone };
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { verifyOtpProofToken, signSessionToken, verifySessionToken };
