// /api/customer/login.js — Vercel Serverless Function
//
// Final step of customer login/signup. The browser has already:
//   1. POSTed /api/send-otp {phone, purpose:'login'}
//   2. POSTed /api/verify-otp {phone, otp} and received a short-lived
//      "otp proof" token
// This endpoint takes that proof token plus the full name typed on the
// welcome screen, and:
//   - if this phone has never been seen before → creates a new customer
//     row using the submitted full name
//   - if this phone already has an account → logs them in as that
//     existing account (their ORIGINAL saved name is kept — the name
//     field on the welcome screen is only used the very first time, so a
//     returning customer typing a different name here does not overwrite
//     their saved profile)
// Either way, issues a 90-day session token the browser stores in
// localStorage so the customer isn't asked for OTP again next visit.
//
// Required environment variables:
//   OTP_TOKEN_SECRET          — same secret used across the OTP system
//   SUPABASE_SERVICE_ROLE_KEY — bypasses RLS; needed because this writes
//                                to the customers table

const { verifyOtpProofToken, signSessionToken } = require('./_tokens');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_SERVICE_ROLE_KEY || !process.env.OTP_TOKEN_SECRET) {
    res.statusCode = 500;
    return res.json({ error: 'Account service is not configured yet. Please contact support.' });
  }

  let body;
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch (e) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid request' });
  }

  const phone = String(body.phone || '').trim();
  const fullName = String(body.fullName || '').trim();
  const otpToken = String(body.token || '');

  if (!/^\d{10}$/.test(phone)) {
    res.statusCode = 400;
    return res.json({ error: 'Invalid phone number.' });
  }
  if (!verifyOtpProofToken(otpToken, phone)) {
    res.statusCode = 401;
    return res.json({ error: 'Your OTP session expired or is invalid. Please verify again.' });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json'
  };

  let customer;
  try {
    const existingResp = await fetch(
      `${SUPABASE_URL}/rest/v1/customers?mobile_number=eq.${phone}&select=*&limit=1`,
      { headers }
    );
    const existingRows = existingResp.ok ? await existingResp.json() : [];
    const existing = existingRows && existingRows[0];

    if (existing) {
      // Returning customer — just refresh last_login_at, keep their saved name.
      const updResp = await fetch(
        `${SUPABASE_URL}/rest/v1/customers?id=eq.${existing.id}`,
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({ last_login_at: new Date().toISOString() })
        }
      );
      const updRows = updResp.ok ? await updResp.json() : [existing];
      customer = updRows[0] || existing;
    } else {
      if (fullName.length < 2) {
        res.statusCode = 400;
        return res.json({ error: 'Please enter your full name.' });
      }
      const insResp = await fetch(`${SUPABASE_URL}/rest/v1/customers`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({
          full_name: fullName,
          mobile_number: phone,
          created_at: new Date().toISOString(),
          last_login_at: new Date().toISOString()
        })
      });
      if (!insResp.ok) {
        // Most likely a race: two tabs signing up with the same number at once.
        const raceResp = await fetch(
          `${SUPABASE_URL}/rest/v1/customers?mobile_number=eq.${phone}&select=*&limit=1`,
          { headers }
        );
        const raceRows = raceResp.ok ? await raceResp.json() : [];
        if (!raceRows || !raceRows[0]) {
          res.statusCode = 502;
          return res.json({ error: 'Could not create your account. Please try again.' });
        }
        customer = raceRows[0];
      } else {
        const insRows = await insResp.json();
        customer = insRows[0];
      }
    }
  } catch (e) {
    res.statusCode = 502;
    return res.json({ error: 'Could not sign you in right now. Please try again.' });
  }

  const sessionToken = signSessionToken(customer.id, customer.mobile_number);

  res.statusCode = 200;
  return res.json({
    token: sessionToken,
    customer: { id: customer.id, full_name: customer.full_name, mobile_number: customer.mobile_number }
  });
};
