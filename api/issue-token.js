// /api/issue-token.js — Vercel Serverless Function
//
// Replaces send-otp.js + verify-otp.js. No SMS, no OTP: sign-up and login
// only need a name and a mobile number.
//
// It hands back the SAME short-lived signed token verify-otp.js used to
// issue (phone.expiresAt.sig, HMAC-SHA256 with OTP_TOKEN_SECRET), so
// /api/customer/login and /api/customer/change-number keep working unchanged.
//
// ONE ACCOUNT PER MOBILE NUMBER (no duplicates):
//   purpose 'login'         — if the number is already registered, the name
//                             typed must match the saved name. Match → the
//                             person is signed back in to the SAME account.
//                             Mismatch → refused, no second account is made.
//   purpose 'change-number' — refused if the new number already belongs to
//                             any account.
//
// Required environment variables:
//   OTP_TOKEN_SECRET          — keep your existing value.
//   SUPABASE_SERVICE_ROLE_KEY — needed to look up existing customers.

const crypto = require('crypto');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OTP_TOKEN_SECRET = process.env.OTP_TOKEN_SECRET;

// Same table/columns as complete-spin.js — change here if yours differ.
const CUSTOMERS_TABLE = 'customers';
const CUSTOMERS_PHONE_COLUMN = 'mobile_number';
const CUSTOMERS_NAME_COLUMN = 'full_name';

const TOKEN_TTL_MS = 5 * 60 * 1000;
const ALLOWED_PURPOSES = ['login', 'change-number'];

function signToken(phone, expiresAt) {
  const payload = `${phone}.${expiresAt}`;
  const sig = crypto.createHmac('sha256', OTP_TOKEN_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}

const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

async function findCustomer(phone) {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${CUSTOMERS_TABLE}?${CUSTOMERS_PHONE_COLUMN}=eq.${phone}` +
    `&select=${CUSTOMERS_PHONE_COLUMN},${CUSTOMERS_NAME_COLUMN}&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  if (!resp.ok) {
    console.error('issue-token: customer lookup failed', resp.status, await resp.text().catch(() => ''));
    throw new Error('lookup failed');
  }
  const rows = await resp.json();
  return rows && rows[0] ? rows[0] : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }
  if (!OTP_TOKEN_SECRET || !SUPABASE_SERVICE_ROLE_KEY) {
    res.statusCode = 500;
    return res.json({ error: 'Sign-up is not configured yet. Please contact support.' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  const phone = String(body.phone || '').trim();
  const purpose = String(body.purpose || 'login');
  const fullName = String(body.fullName || '');

  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Please enter a valid 10-digit mobile number.' });
  }
  if (!ALLOWED_PURPOSES.includes(purpose)) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  try {
    const existing = await findCustomer(phone);

    if (purpose === 'login' && existing) {
      if (normName(existing[CUSTOMERS_NAME_COLUMN]) !== normName(fullName)) {
        res.statusCode = 409;
        return res.json({ error: 'This mobile number is already registered with a different name. Enter the name you signed up with.' });
      }
      // name matches → fall through: signed back in to the same account
    }

    if (purpose === 'change-number' && existing) {
      res.statusCode = 409;
      return res.json({ error: 'This mobile number already belongs to another account.' });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not check your account right now. Please try again.' });
  }

  const expiresAt = Date.now() + TOKEN_TTL_MS;
  res.statusCode = 200;
  return res.json({ token: signToken(phone, expiresAt), expiresAt });
};
