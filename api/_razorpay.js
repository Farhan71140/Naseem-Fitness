// /api/_razorpay.js — shared helpers (the leading underscore stops Vercel
// from exposing this file as a public endpoint).
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   RAZORPAY_KEY_ID           rzp_live_xxx   (or rzp_test_xxx while testing)
//   RAZORPAY_KEY_SECRET       the secret shown once when you generated the key
//   RAZORPAY_WEBHOOK_SECRET   any strong string; paste the same one in the Razorpay webhook form
//   SUPABASE_SERVICE_ROLE_KEY already set for your OTP / spin APIs

const crypto = require('crypto');

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const svcHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json'
});

const rzpAuth = () => 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');

function configured() {
  return !!(SERVICE_KEY && KEY_ID && KEY_SECRET);
}

function safeEqualHex(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function istToday() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: svcHeaders() });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}

async function rzpFetch(path, opts = {}) {
  const r = await fetch(`https://api.razorpay.com/v1/${path}`, {
    ...opts,
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data.error && data.error.description) || `razorpay ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// Turns a paid Razorpay order into a real row in `orders`. Safe to call many
// times (browser callback + webhook both call it): the unique index on
// orders.razorpay_order_id guarantees only one order is ever created.
async function finalizeOrder(razorpayOrderId, paymentId) {
  // 1. Already finalized? Return it.
  const existing = await sbGet(`orders?razorpay_order_id=eq.${encodeURIComponent(razorpayOrderId)}&select=id,created_at&limit=1`);
  let draftRow = null;
  const attempts = await sbGet(`payment_attempts?razorpay_order_id=eq.${encodeURIComponent(razorpayOrderId)}&select=*&limit=1`);
  draftRow = attempts[0];
  if (!draftRow) throw Object.assign(new Error('Unknown payment attempt'), { status: 404 });
  const draft = draftRow.draft;

  // 2. Ask Razorpay directly what happened — never trust the browser alone.
  let payment = await rzpFetch(`payments/${encodeURIComponent(paymentId)}`);
  if (payment.order_id !== razorpayOrderId) throw Object.assign(new Error('Payment does not belong to this order'), { status: 400 });
  if (Math.round(Number(draftRow.payable) * 100) !== Number(payment.amount)) throw Object.assign(new Error('Amount mismatch'), { status: 400 });
  if (payment.status === 'authorized') {
    // Only happens if auto-capture is off in the Razorpay dashboard.
    payment = await rzpFetch(`payments/${encodeURIComponent(paymentId)}/capture`, {
      method: 'POST',
      body: JSON.stringify({ amount: payment.amount, currency: 'INR' })
    });
  }
  if (payment.status !== 'captured') throw Object.assign(new Error('Payment not captured'), { status: 402 });

  let orderId, createdAt;
  if (existing[0]) {
    orderId = existing[0].id; createdAt = existing[0].created_at;
  } else {
    const isCod = draftRow.context === 'cod';
    const row = {
      ...draft.order,
      payment_method: isCod ? 'cod' : 'upi',
      advance_paid: isCod ? true : false,
      upi_paid: isCod ? undefined : true,
      upi_app: 'razorpay',
      upi_ref: paymentId,
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      payment_status: 'paid',
      payment_channel: payment.method || null,
      paid_at: new Date().toISOString()
    };
    if (row.upi_paid === undefined) delete row.upi_paid;

    const ins = await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: { ...svcHeaders(), Prefer: 'return=representation' },
      body: JSON.stringify(row)
    });
    if (ins.ok) {
      const rows = await ins.json();
      orderId = rows[0].id; createdAt = rows[0].created_at;
    } else {
      // Probably lost the race against the webhook — fetch the winner.
      const again = await sbGet(`orders?razorpay_order_id=eq.${encodeURIComponent(razorpayOrderId)}&select=id,created_at&limit=1`);
      if (!again[0]) throw new Error('Could not save order');
      orderId = again[0].id; createdAt = again[0].created_at;
    }

    // Mark the Lucky Spin reward as used (best effort).
    if (draft.reward && draft.reward.id) {
      fetch(`${SUPABASE_URL}/rest/v1/lucky_spins?id=eq.${encodeURIComponent(draft.reward.id)}`, {
        method: 'PATCH', headers: svcHeaders(),
        body: JSON.stringify({ status: 'used', order_number: 'NF-' + String(orderId).slice(0, 8).toUpperCase() })
      }).catch(() => {});
    }
  }

  fetch(`${SUPABASE_URL}/rest/v1/payment_attempts?razorpay_order_id=eq.${encodeURIComponent(razorpayOrderId)}`, {
    method: 'PATCH', headers: svcHeaders(), body: JSON.stringify({ status: 'paid' })
  }).catch(() => {});

  return {
    orderRef: 'NF-' + String(orderId).slice(0, 8).toUpperCase(),
    createdAt,
    paymentId,
    method: payment.method || null,
    amountPaid: Number(draftRow.payable),
    total: draft.summary.total,
    remaining: draft.summary.remaining,
    isCod: draftRow.context === 'cod',
    reward: draft.reward ? { type: draft.reward.reward_type, label: draft.reward.reward_label, value: draft.reward.reward_value } : null
  };
}

module.exports = { SUPABASE_URL, SERVICE_KEY, KEY_ID, KEY_SECRET, svcHeaders, configured, safeEqualHex, istToday, sbGet, rzpFetch, finalizeOrder };
