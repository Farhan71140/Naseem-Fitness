// /api/shiprocket-serviceability.js — Vercel Serverless Function
//
// Replaces the old manually-maintained "Fast Delivery PIN codes" table.
// Called from the checkout PIN code field — checks LIVE against
// Shiprocket's Courier Serviceability API whether an Air/Express courier
// can deliver to the customer's PIN code for the current cart weight, and
// returns the fastest ETA if so.
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
    const couriers = (data && data.data && data.data.available_courier_companies) || [];
    console.log(`[shiprocket-serviceability] pincode ${pincode}: ${couriers.length} total couriers, response status: ${data && data.status_code}`);

    // Shiprocket flags each courier with is_surface: true (surface/road) or
    // false (air). We only want couriers actually offering Air/Express.
    const airCouriers = couriers.filter(c => c && c.is_surface === false);
    console.log(`[shiprocket-serviceability] pincode ${pincode}: ${airCouriers.length} air couriers among them`);

    if (airCouriers.length === 0) {
      res.statusCode = 200;
      return res.json({ available: false, ...(debug ? { debug_total_couriers: couriers.length, debug_air_couriers: 0, debug_raw_status: data && data.status_code, debug_raw_message: data && data.message } : {}) });
    }

    // Pick the fastest ETD among available air couriers.
    const parseEtd = (c) => {
      const d = c.etd ? new Date(c.etd) : null;
      return d && !isNaN(d) ? d.getTime() : Infinity;
    };
    airCouriers.sort((a, b) => parseEtd(a) - parseEtd(b));
    const best = airCouriers[0];

    let eta = 'Priority Air Express shipping';
    if (best.etd) {
      const d = new Date(best.etd);
      if (!isNaN(d)) {
        eta = `Estimated delivery by ${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} via Air Express`;
      }
    }

    res.statusCode = 200;
    return res.json({
      available: true,
      eta,
      courier_name: best.courier_name || null
    });
  } catch (e) {
    console.error(`[shiprocket-serviceability] Exception for pincode ${pincode}:`, e.message);
    // Any failure (credentials missing, Shiprocket down, etc.) — fail safe.
    res.statusCode = 200;
    return res.json({ available: false, ...(debug ? { debug_error: e.message } : {}) });
  }
};
