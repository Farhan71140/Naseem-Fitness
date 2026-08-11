// /api/product.js — Vercel Serverless Function
//
// Serves a unique, crawlable HTML page per product at /product/{id}.
//
// Why this exists:
// Product pages used to only exist as a client-side modal on index.html
// (?product=ID), with a canonical tag hardcoded to the homepage and a
// <title> that never changed. Google saw every product URL as an
// identical duplicate of "/" and refused to index them ("Duplicate
// without user-selected canonical" in Search Console).
//
// This function fetches the single product from Supabase, takes the
// SAME index.html your users already get (so the site, cart, styling,
// everything stays identical), and rewrites the <title>, meta
// description, canonical URL, Open Graph tags and JSON-LD product
// schema so THIS URL is unique and self-referencing. The existing
// front-end JS (openSharedProductFromUrl) then opens the product modal
// automatically using window.__SSR_PRODUCT_ID, which this function
// injects.

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CQawBi0OPWWHKBIUnHr1Dg_OK4cuKIh';
const SITE_URL = 'https://nfsupplementstore.com';

function escapeHtml(str) {
  return String(str || '').replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

module.exports = async function handler(req, res) {
  const id = req.query.id;

  if (!id) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'text/plain');
    return res.end('Missing product id');
  }

  let product = null;
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (resp.ok) {
      const rows = await resp.json();
      product = rows && rows[0] ? rows[0] : null;
    }
  } catch (e) {
    product = null;
  }

  // Product doesn't exist (deleted/bad id) — tell Google it's really gone,
  // don't silently serve the homepage as if this were a valid product URL.
  if (!product) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end(
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Product not found | NF Naseem Fitness</title>` +
      `<meta name="robots" content="noindex"></head><body>` +
      `<p>This product could not be found. <a href="${SITE_URL}/">Return to the store</a>.</p>` +
      `</body></html>`
    );
  }

  // Fetch the same index.html your users get, so the app/cart/nav/styling
  // stay identical — we only rewrite the <head> metadata below.
  let html;
  try {
    const pageResp = await fetch(`${SITE_URL}/index.html`);
    html = await pageResp.text();
  } catch (e) {
    res.statusCode = 502;
    return res.end('Could not load site shell');
  }

  const productUrl = `${SITE_URL}/product/${encodeURIComponent(product.id)}`;
  const name = product.name || 'Supplement';
  const brand = product.brand || 'NF Naseem Fitness';
  const price = product.price;
  const description = product.description
    || `${brand} ${name} — genuine, 100% authentic supplement from NF Naseem Fitness, Mumbai. Pan-India delivery.`;
  const title = `${brand} ${name} | Buy Online | NF Naseem Fitness™`;

  let image = '';
  try {
    if (Array.isArray(product.images) && product.images.length) image = product.images[0];
    else if (typeof product.image === 'string') image = product.image;
  } catch (e) { /* noop */ }
  if (image && !image.startsWith('http')) image = `${SITE_URL}/${image.replace(/^\//, '')}`;

  const stock = (product.stock === undefined || product.stock === null) ? null : Number(product.stock);
  const outOfStock = stock !== null && stock <= 0;

  const jsonLd = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name,
    sku: product.id,
    url: productUrl,
    description,
    brand: { '@type': 'Brand', name: brand },
    ...(image ? { image: [image] } : {}),
    offers: {
      '@type': 'Offer',
      priceCurrency: 'INR',
      price,
      availability: outOfStock ? 'https://schema.org/OutOfStock' : 'https://schema.org/InStock',
      url: productUrl
    }
  };

  // --- Rewrite <head> metadata so this URL is unique & self-referencing ---
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtml(title)}</title>`
  );
  html = html.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="${escapeHtml(description).slice(0, 300)}">`
  );
  html = html.replace(
    /<link rel="canonical" href="[^"]*">/,
    `<link rel="canonical" href="${productUrl}">`
  );
  html = html.replace(
    '<!--SSR_OG_TAGS-->',
    `<meta property="og:type" content="product">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description).slice(0, 300)}">
<meta property="og:url" content="${productUrl}">
${image ? `<meta property="og:image" content="${escapeHtml(image)}">` : ''}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script>window.__SSR_PRODUCT_ID = ${JSON.stringify(product.id)};</script>`
  );

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Cache at the edge so we're not hammering Supabase on every crawl,
  // but keep it fresh enough that price/stock changes show up quickly.
  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  return res.end(html);
};
