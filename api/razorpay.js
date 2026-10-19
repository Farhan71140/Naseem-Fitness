// /api/razorpay.js — ONE serverless function that serves all Razorpay routes.
// (Vercel's free Hobby plan allows max 12 functions, so the three Razorpay
// endpoints share this single entry point. The real logic lives in the
// underscore files, which Vercel does NOT count as functions.)
//
// vercel.json rewrites keep the original URLs working:
//   /api/create-razorpay-order    -> /api/razorpay?action=create
//   /api/verify-razorpay-payment  -> /api/razorpay?action=verify
//   /api/razorpay-webhook         -> /api/razorpay?action=webhook

const create = require('./_create');
const verify = require('./_verify');
const webhook = require('./_webhook');

// Keep the raw body: the webhook signature must be checked against the exact bytes.
module.exports.config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    if (req.readableEnded && req.body !== undefined) {
      return resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = Object.assign(async function handler(req, res) {
  const action = String((req.query && req.query.action) || '');
  const routes = { create, verify, webhook };
  const route = routes[action];
  if (!route) { res.statusCode = 404; return res.end('Not found'); }

  if (req.method === 'POST') {
    try { req.rawBody = await readRaw(req); }
    catch (e) { res.statusCode = 400; return res.end('Bad body'); }
    if (action !== 'webhook') {
      try { req.body = req.rawBody ? JSON.parse(req.rawBody) : {}; }
      catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'Invalid request' })); }
    }
  }
  return route(req, res);
}, { config: { api: { bodyParser: false } } });
