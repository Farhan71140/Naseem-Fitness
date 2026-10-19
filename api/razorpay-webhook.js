// /api/razorpay-webhook.js — Safety net
// If a customer pays and then closes the tab / loses signal, the browser never
// calls verify. Razorpay calls THIS endpoint instead, so the order is still created.
//
// Razorpay Dashboard → Settings → Webhooks → Add:
//   URL:    https://www.nfsupplementstore.com/api/razorpay-webhook
//   Secret: the same value as RAZORPAY_WEBHOOK_SECRET
//   Events: payment.captured, order.paid, payment.failed

const crypto = require('crypto');
const { SUPABASE_URL, svcHeaders, configured, safeEqualHex, finalizeOrder } = require('./_razorpay');

// We need the exact raw bytes to check the signature.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    if (req.readableEnded && req.body) {
      return resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method not allowed'); }
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!configured() || !secret) { res.statusCode = 500; return res.end('Not configured'); }

  let raw;
  try { raw = await readRaw(req); } catch (e) { res.statusCode = 400; return res.end('Bad body'); }

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqualHex(expected, req.headers['x-razorpay-signature'])) {
    res.statusCode = 401; return res.end('Invalid signature');
  }

  let event;
  try { event = JSON.parse(raw); } catch (e) { res.statusCode = 400; return res.end('Bad JSON'); }

  try {
    const type = event.event;
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;

    if ((type === 'payment.captured' || type === 'order.paid') && payment) {
      await finalizeOrder(payment.order_id, payment.id);
    } else if (type === 'payment.failed' && payment) {
      fetch(`${SUPABASE_URL}/rest/v1/payment_attempts?razorpay_order_id=eq.${encodeURIComponent(payment.order_id)}&status=eq.created`, {
        method: 'PATCH', headers: svcHeaders(), body: JSON.stringify({ status: 'failed' })
      }).catch(() => {});
    }
    res.statusCode = 200; return res.end('ok');
  } catch (e) {
    // Unknown attempt (e.g. a payment not from this site) → acknowledge so Razorpay stops retrying.
    if (e.status === 404 || e.status === 400) { res.statusCode = 200; return res.end('ignored'); }
    res.statusCode = 500; return res.end('retry');   // transient → Razorpay will retry
  }
};
