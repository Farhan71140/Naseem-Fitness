// /api/verify-otp.js — Vercel Serverless Function
//
// Step 2 of the OTP-gated Lucky Spin. Checks the code the customer typed
// against MSG91 (MSG91 stores/expires the real OTP server-side — we never
// generate or store OTPs ourselves). On success, issues a short-lived
// signed token that /api/complete-spin.js will require before it will
// write a reward. The token — not a plain "verified: true" flag — is what
// makes this un-fakeable from devtools: it's a real HMAC signature that
// only this server (which holds OTP_TOKEN_SECRET) can produce or check.
//
// Required environment variables:
//   MSG91_AUTH_KEY   — same as send-otp.js
//   OTP_TOKEN_SECRET — any long random string, used only to sign/verify
//                      tokens; generate once and keep it secret

const crypto = require('crypto');

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const OTP_TOKEN_SECRET = process.env.OTP_TOKEN_SECRET;
const TOKEN_TTL_MS = 5 * 60 * 1000; // token is valid 5 minutes after OTP verification

function signToken(phone, expiresAt) {
  const payload = `${phone}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }

  if (!MSG91_AUTH_KEY || !OTP_TOKEN_SECRET) {
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

  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid phone number.' });
  }
  if (!/^\d{4,6}$/.test(otp)) {
    res.statusCode = 400;
    return res.json({ error: 'Please enter the OTP.' });
  }

  const mobileWithCode = `91${phone}`;

  try {
    const msgResp = await fetch(
      `https://control.msg91.com/api/v5/otp/verify?mobile=${mobileWithCode}&otp=${encodeURIComponent(otp)}`,
      { headers: { authkey: MSG91_AUTH_KEY } }
    );
    const msgBody = await msgResp.json().catch(() => ({}));

    // MSG91 returns type:'success' on a correct, unexpired OTP.
    if (!msgResp.ok || msgBody.type !== 'success') {
      res.statusCode = 401;
      return res.json({ error: 'Incorrect or expired OTP. Please try again.' });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not verify OTP right now. Please try again.' });
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const token = signToken(phone, expiresAt);

  res.statusCode = 200;
  return res.json({ token, expiresAt });
};
