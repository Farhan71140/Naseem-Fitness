// /api/customer/delete.js — Vercel Serverless Function
//
// Deletes the customer's account row. Their past orders are left
// untouched (orders are keyed by mobile_number/customer_name at the time
// of purchase, not by a foreign key to this table) — deleting the
// account only removes their saved profile/login, not their order
// history on your side.
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
    const delResp = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?id=eq.${session.customerId}`,
      {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );
    if (!delResp.ok) {
      res.statusCode = 502;
      return res.json({ error: 'Could not delete your account. Please try again.' });
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not delete your account right now. Please try again.' });
  }

  res.statusCode = 200;
  return res.json({ deleted: true });
};
