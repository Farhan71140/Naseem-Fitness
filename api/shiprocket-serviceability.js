// /api/shiprocket-serviceability.js — Vercel Serverless Function
//
// Replaces the old manually-maintained "Fast Delivery PIN codes" table.
// Called from the checkout PIN code field — checks LIVE against
// Shiprocket's Courier Serviceability API whether SHIPROCKET QUICK
// (same-day/instant hyperlocal delivery) can deliver to the customer's
// PIN code for the current cart weight, and returns Quick's actual
// computed rate + ETA if so. Shiprocket Quick shows up as one entry
// (courier_name: "Shiprocket Quick") in the normal serviceability
// response — no separate Hyperlocal endpoint needed.
//
// Shiprocket credentials are read from environment variables, never
// exposed to the browser:
//   SHIPROCKET_EMAIL
//   SHIPROCKET_PASSWORD
// Set these in Vercel → Project → Settings → Environment Variables.

const SHIPROCKET_BASE = 'https://apiv2.shiprocket.in/v1/external';

// Your pickup/warehouse PIN code (Mumbai store).
const PICKUP_POSTCODE = '400008';

// Shiprocket auth tokens are valid ~10 days. Cache on the warm serverless
// instance so we don't re-login on every single checkout PIN code check.
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getShiprocketToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const email = process.env.SHIPROCKET_EMAIL;
  const password = process.env.SHIPROCKET_PASSWORD;
  if (!email || !password) {
    throw new Error('Shiprocket credentials not configured (SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD env vars missing)');
  }

  const resp = await fetch(`${SHIPROCKET_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!resp.ok) throw new Error(`Shiprocket login failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.token) throw new Error('Shiprocket login did not return a token');

  cachedToken = data.token;
  // Refresh a little early — cache for 9 days instead of the full ~10.
  cachedTokenExpiry = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return cachedToken;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');

  const pincode = String(req.query.pincode || '').trim();
  const weightRaw = Number(req.query.weight);
  const debug = req.query.debug === '1';
  // Shiprocket needs a minimum parcel weight; 0.5kg is a safe floor for a
  // supplement order (protein tubs etc. will report their real weight).
  const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 0.5;

  if (!/^\d{6}$/.test(pincode)) {
    res.statusCode = 400;
    return res.json({ available: false, error: 'Invalid PIN code' });
  }

  try {
    const token = await getShiprocketToken();

    const url = `${SHIPROCKET_BASE}/courier/serviceability/`
      + `?pickup_postcode=${PICKUP_POSTCODE}`
      + `&delivery_postcode=${encodeURIComponent(pincode)}`
      + `&weight=${encodeURIComponent(weight)}`
      + `&cod=0`;

    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => '');
      console.error(`[shiprocket-serviceability] Serviceability API returned ${resp.status} for pincode ${pincode}:`, bodyText);
      // Serviceability lookup failed — fail safe, just don't offer Fast
      // Delivery rather than breaking checkout.
      res.statusCode = 200;
      return res.json({ available: false, ...(debug ? { debug_error: `Shiprocket API ${resp.status}`, debug_body: bodyText } : {}) });
    }

    const data = await resp.json();
    // The response shape can vary slightly (available_courier_companies is the
    // common key; some Hyperlocal docs show `data` as the array directly) —
    // handle both.
    const couriers = (data && data.data && Array.isArray(data.data.available_courier_companies))
      ? data.data.available_courier_companies
      : (data && Array.isArray(data.data) ? data.data : []);
    console.log(`[shiprocket-serviceability] pincode ${pincode}: ${couriers.length} total couriers returned`);

    // "Fast Delivery" on the site specifically means Shiprocket QUICK
    // (same-day/instant hyperlocal delivery) — not just any Air Express
    // courier. Shiprocket Quick shows up as one entry in this same
    // serviceability response, named "Shiprocket Quick", when it's
    // serviceable for this PIN code pair.
    const quick = couriers.find(c => c && c.courier_name && /quick/i.test(c.courier_name));

    if (!quick) {
      res.statusCode = 200;
      return res.json({ available: false, ...(debug ? { debug_total_couriers: couriers.length, debug_courier_names: couriers.map(c => c && c.courier_name) } : {}) });
    }

    // Rate sometimes comes back as a string ("345.3") rather than a number.
    const rawRate = Number(quick.rate ?? quick.rates);
    const rate = Number.isFinite(rawRate) && rawRate > 0 ? Math.ceil(rawRate) : null;

    let eta = 'Same-day delivery via Shiprocket Quick';
    if (quick.etd) {
      const d = new Date(quick.etd);
      if (!isNaN(d)) {
        eta = `Estimated delivery by ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} via Shiprocket Quick`;
      }
    }

    res.statusCode = 200;
    return res.json({
      available: true,
      eta,
      rate,
      courier_name: quick.courier_name
    });
  } catch (e) {
    console.error(`[shiprocket-serviceability] Exception for pincode ${pincode}:`, e.message);
    // Any failure (credentials missing, Shiprocket down, etc.) — fail safe.
    res.statusCode = 200;
    return res.json({ available: false, ...(debug ? { debug_error: e.message } : {}) });
  }
};
