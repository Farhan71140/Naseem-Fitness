// /api/create-razorpay-order.js — Step 1
// The browser sends WHAT is in the cart (ids + quantities) — never prices.
// We recompute every rupee here from the database, create the Razorpay order,
// and park the checkout details in `payment_attempts` until payment succeeds.

const { SUPABASE_URL, KEY_ID, svcHeaders, configured, istToday, sbGet, rzpFetch } = require('./_razorpay');

const FREE_DELIVERY_THRESHOLD = 899;
const DELIVERY_FEE = 99;
const FAST_DELIVERY_FEE = 149;
const SPIN_UNLOCK_THRESHOLD = 1500;
const COD_ADVANCE_PCT = 15;
const ID_RE = /^[A-Za-z0-9_-]+$/;

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.json({ error: 'Method not allowed' }); }
  if (!configured()) { res.statusCode = 500; return res.json({ error: 'Payments are not configured yet. Please contact support.' }); }

  let body;
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { res.statusCode = 400; return res.json({ error: 'Invalid request' }); }

  const context = body.context === 'cod' ? 'cod' : 'full';
  const name = clean(body.name, 80);
  const phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
  const address = clean(body.address, 500);
  const pincode = String(body.pincode || '').trim();
  const fast = body.delivery === 'fast';
  const lines = Array.isArray(body.items) ? body.items.slice(0, 40) : [];

  if (!name) { res.statusCode = 400; return res.json({ error: 'Please enter your name.' }); }
  if (!/^\d{10}$/.test(phone)) { res.statusCode = 400; return res.json({ error: 'Please enter a valid 10-digit phone number.' }); }
  if (address.length < 6) { res.statusCode = 400; return res.json({ error: 'Please enter your full delivery address.' }); }
  if (!/^\d{6}$/.test(pincode)) { res.statusCode = 400; return res.json({ error: 'Please enter a valid 6-digit PIN code.' }); }
  if (!lines.length) { res.statusCode = 400; return res.json({ error: 'Your cart is empty.' }); }

  // ---- Re-price the cart from the database ----
  const parsed = [];
  for (const l of lines) {
    const rawId = String(l.id || '');
    const qty = Number(l.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 50) { res.statusCode = 400; return res.json({ error: 'Invalid quantity in cart.' }); }
    const isCombo = rawId.startsWith('combo-');
    const baseId = isCombo ? rawId.slice(6) : rawId.split('::')[0];
    if (!ID_RE.test(baseId)) { res.statusCode = 400; return res.json({ error: 'Invalid item in cart.' }); }
    parsed.push({ isCombo, baseId, qty, label: clean(l.name, 140) });
  }

  const productIds = [...new Set(parsed.filter(p => !p.isCombo).map(p => p.baseId))];
  const comboIds = [...new Set(parsed.filter(p => p.isCombo).map(p => p.baseId))];

  let products = [], combos = [];
  try {
    if (productIds.length) products = await sbGet(`products?id=in.(${productIds.map(encodeURIComponent).join(',')})&select=id,name,price,stock,weight_kg`);
    if (comboIds.length) combos = await sbGet(`combo_offers?id=in.(${comboIds.map(encodeURIComponent).join(',')})&select=id,name,offer_price,active`);
  } catch (e) {
    res.statusCode = 502; return res.json({ error: 'Could not verify your cart. Please try again.' });
  }

  let subtotal = 0, weight = 0;
  const items = [];
  for (const p of parsed) {
    const rec = p.isCombo ? combos.find(c => String(c.id) === p.baseId) : products.find(x => String(x.id) === p.baseId);
    if (!rec || (p.isCombo && rec.active === false)) { res.statusCode = 409; return res.json({ error: 'An item in your cart is no longer available. Please refresh and try again.' }); }
    if (!p.isCombo && rec.stock !== undefined && rec.stock !== null && Number(rec.stock) < p.qty) {
      res.statusCode = 409; return res.json({ error: `Only ${Math.max(0, Number(rec.stock))} left of ${rec.name}. Please reduce the quantity.` });
    }
    const price = Number(p.isCombo ? rec.offer_price : rec.price);
    if (!(price >= 0)) { res.statusCode = 409; return res.json({ error: 'Pricing error. Please refresh and try again.' }); }
    subtotal += price * p.qty;
    if (!p.isCombo && rec.weight_kg) weight += Number(rec.weight_kg) * p.qty;
    items.push({ name: p.label || (p.isCombo ? rec.name + ' (Combo)' : rec.name), price, qty: p.qty });
  }

  // ---- Lucky Spin reward (verified server-side) ----
  let reward = null, discount = 0;
  try {
    const rows = await sbGet(`lucky_spins?mobile_number=eq.${phone}&spin_date=eq.${istToday()}&status=eq.active&select=*&limit=1`);
    if (rows[0] && subtotal >= SPIN_UNLOCK_THRESHOLD) reward = rows[0];
  } catch (e) { /* no reward */ }
  if (reward && reward.reward_type === 'discount') discount = Math.min(subtotal, Number(reward.reward_value) || 0);
  if (reward && reward.reward_type === 'free_item') items.push({ name: `🎁 FREE ${reward.reward_label} (Lucky Spin Reward)`, price: 0, qty: 1 });

  // ---- Delivery + totals ----
  const deliveryFee = fast ? FAST_DELIVERY_FEE : (subtotal >= FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE);
  const total = Math.max(0, subtotal - discount) + deliveryFee;
  const advance = Math.round(total * COD_ADVANCE_PCT / 100);
  const remaining = context === 'cod' ? total - advance : 0;
  const payable = context === 'cod' ? advance : total;
  if (payable < 1) { res.statusCode = 400; return res.json({ error: 'Order amount is too low to process.' }); }

  const order = {
    customer_name: name, phone, address, items,
    amount: total, status: 'pending',
    advance_amount: context === 'cod' ? advance : 0,
    remaining_amount: remaining,
    delivery_type: fast ? 'fast' : 'standard',
    delivery_pincode: pincode,
    delivery_fee: deliveryFee,
    order_weight_kg: weight || null
  };

  // ---- Create the Razorpay order ----
  let rzpOrder;
  try {
    rzpOrder = await rzpFetch('orders', {
      method: 'POST',
      body: JSON.stringify({
        amount: Math.round(payable * 100),
        currency: 'INR',
        receipt: ('NF' + Date.now()).slice(0, 40),
        notes: { phone, context, customer: name.slice(0, 40) }
      })
    });
  } catch (e) {
    res.statusCode = 502; return res.json({ error: 'Could not start the payment. Please try again in a moment.' });
  }

  try {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/payment_attempts`, {
      method: 'POST', headers: svcHeaders(),
      body: JSON.stringify({
        razorpay_order_id: rzpOrder.id, context, payable,
        draft: { order, reward: reward || null, summary: { subtotal, discount, deliveryFee, total, advance, remaining } }
      })
    });
    if (!ins.ok) throw new Error('insert failed');
  } catch (e) {
    res.statusCode = 502; return res.json({ error: 'Could not start the payment. Please try again.' });
  }

  res.statusCode = 200;
  return res.json({
    keyId: KEY_ID,
    razorpayOrderId: rzpOrder.id,
    amountPaise: rzpOrder.amount,
    payable, total, advance, remaining, subtotal, discount, deliveryFee
  });
};
