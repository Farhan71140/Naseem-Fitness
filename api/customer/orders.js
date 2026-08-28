// /api/customer/orders.js — Vercel Serverless Function
//
// Returns the logged-in customer's past orders, matched by the mobile
// number saved on their account. Requires a valid session token rather
// than letting the browser just ask for "orders for phone X" directly —
// otherwise anyone could read anyone else's order history by guessing
// phone numbers.
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

  const session = verifySessionToken(String(body.sessionToken || ''));
  if (!session) {
    res.statusCode = 401;
    return res.json({ error: 'Your session expired. Please log in again.' });
  }

  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?phone=eq.${session.phone}&select=*&order=created_at.desc&limit=50`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!resp.ok) {
      res.statusCode = 502;
      return res.json({ error: 'Could not load your orders right now.' });
    }
    const orders = await resp.json();
    res.statusCode = 200;
    return res.json({ orders });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not load your orders right now.' });
  }
};
