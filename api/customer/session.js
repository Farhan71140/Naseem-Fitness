// /api/customer/session.js — Vercel Serverless Function
//
// Called once on every page load with whatever session token is saved in
// localStorage. Validates the token's signature/expiry, then re-fetches
// the customer's current record from Supabase (rather than trusting
// stale data baked into the token) so name changes made elsewhere are
// always reflected. This is what makes "next time, no OTP needed" work.
//
// Required environment variables:
//   OTP_TOKEN_SECRET
//   SUPABASE_SERVICE_ROLE_KEY

const { verifySessionToken } = require('./_tokens');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_SERVICE_ROLE_KEY || !process.env.OTP_TOKEN_SECRET) {
    res.statusCode = 500;
    return res.json({ error: 'Account service is not configured yet.' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  const token = String(body.token || '');
  const claim = verifySessionToken(token);
  if (!claim) {
    res.statusCode = 401;
    return res.json({ error: 'Session expired' });
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?id=eq.${claim.customerId}&select=id,full_name,mobile_number&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const rows = resp.ok ? await resp.json() : [];
    const customer = rows && rows[0];
    if (!customer) {
      // Account was deleted since this token was issued.
      res.statusCode = 401;
      return res.json({ error: 'Account no longer exists' });
    }
    res.statusCode = 200;
    return res.json({ customer });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not verify session right now.' });
  }
};
