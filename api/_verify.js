// /api/verify-razorpay-payment.js — Step 2
// Called by the browser right after Razorpay's popup reports success.
// Verifies Razorpay's signature, double-checks the payment with Razorpay's
// servers, then creates the real order.

const crypto = require('crypto');
const { KEY_SECRET, configured, safeEqualHex, finalizeOrder } = require('./_razorpay');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'Method not allowed' }); }
  if (!configured()) { res.statusCode = 500; return res.json({ error: 'Payments are not configured yet.' }); }

  let body;
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { res.statusCode = 400; return res.json({ error: 'Invalid request' }); }

  const orderId = String(body.razorpay_order_id || '');
  const paymentId = String(body.razorpay_payment_id || '');
  const signature = String(body.razorpay_signature || '');
  if (!/^order_\w+$/.test(orderId) || !/^pay_\w+$/.test(paymentId) || !signature) {
    res.statusCode = 400; return res.json({ error: 'Invalid payment details.' });
  }

  const expected = crypto.createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqualHex(expected, signature)) {
    res.statusCode = 400; return res.json({ error: 'Payment signature could not be verified.' });
  }

  try {
    const result = await finalizeOrder(orderId, paymentId);
    res.statusCode = 200;
    return res.json({ ok: true, ...result });
  } catch (e) {
    res.statusCode = e.status || 502;
    return res.json({ error: e.message || 'Could not confirm your order. If money was deducted, do not pay again — the webhook will confirm it shortly.' });
  }
};
