// /api/customer/change-number.js — Vercel Serverless Function
//
// Requires TWO separate proofs before a number can be changed:
//   1. A valid existing session token — proves this browser is already
//      logged in as some customer.
//   2. A freshly verified OTP proof token for the NEW number — proves
//      they actually own the new number too (same /api/verify-otp used
//      everywhere else). Without this, anyone with a stolen session
//      token/localStorage could silently move the account to a number
//      they don't own.
//
// Required environment variables:
//   OTP_TOKEN_SECRET
//   SUPABASE_SERVICE_ROLE_KEY

const { verifyOtpProofToken, verifySessionToken, signSessionToken } = require('./_tokens');

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

  const sessionToken = String(body.sessionToken || '');
  const newPhone = String(body.newPhone || '').trim();
  const otpToken = String(body.otpToken || '');

  const session = verifySessionToken(sessionToken);
  if (!session) {
    res.statusCode = 401;
    return res.json({ error: 'Your session expired. Please log in again.' });
  }
  if (!/^\d{10}$/.test(newPhone)) {
    res.statusCode = 400;
    return res.json({ error: 'Please enter a valid 10-digit mobile number.' });
  }
  if (newPhone === session.phone) {
    res.statusCode = 400;
    return res.json({ error: 'That is already your current number.' });
  }
  if (!verifyOtpProofToken(otpToken, newPhone)) {
    res.statusCode = 401;
    return res.json({ error: 'OTP verification for the new number expired. Please try again.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    // Refuse if the new number is already linked to a different account.
    const clashResp = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?mobile_number=eq.${newPhone}&select=id&limit=1`,
      { headers }
    );
    const clashRows = clashResp.ok ? await clashResp.json() : [];
    if (clashRows && clashRows[0] && clashRows[0].id !== session.customerId) {
      res.statusCode = 409;
      return res.json({ error: 'This number is already linked to another account.' });
    }

    const updResp = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?id=eq.${session.customerId}`,
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ mobile_number: newPhone })
      }
    );
    if (!updResp.ok) {
      res.statusCode = 502;
      return res.json({ error: 'Could not update your number. Please try again.' });
    }
    const rows = await updResp.json();
    const customer = rows[0];
    if (!customer) {
      res.statusCode = 401;
      return res.json({ error: 'Account no longer exists.' });
    }

    const newSessionToken = signSessionToken(customer.id, customer.mobile_number);
    res.statusCode = 200;
    return res.json({
      token: newSessionToken,
      customer: { id: customer.id, full_name: customer.full_name, mobile_number: customer.mobile_number }
    });
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not update your number right now. Please try again.' });
  }
};
