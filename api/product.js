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
const SITE_URL = 'https://www.nfsupplementstore.com';
function escapeHtml(str) {
  return String(str || '').replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

// Reads just enough bytes of an image to determine its pixel dimensions,
// without downloading the whole file. WhatsApp (and Facebook/Twitter) use
// og:image:width / og:image:height as a strong hint for picking the large,
// top-of-card image layout — without them, previews often fall back to a
// small thumbnail or no image at all, even though og:image is valid.
async function getImageDimensions(url) {
  try {
    const resp = await fetch(url, { headers: { Range: 'bytes=0-65535' } });
    if (!resp.ok && resp.status !== 206) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length < 24) return null;

    // PNG: signature, then IHDR chunk holds width/height as big-endian uint32s
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      const width = (buf[16] << 24) | (buf[17] << 16) | (buf[18] << 8) | buf[19];
      const height = (buf[20] << 24) | (buf[21] << 16) | (buf[22] << 8) | buf[23];
      if (width > 0 && height > 0) return { width, height };
      return null;
    }

    // JPEG: walk the marker segments until we hit a Start-Of-Frame marker
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let pos = 2;
      while (pos + 9 < buf.length) {
        if (buf[pos] !== 0xff) { pos++; continue; }
        const marker = buf[pos + 1];
        if (marker === 0xd8 || marker === 0xd9) { pos += 2; continue; }
        if (marker >= 0xd0 && marker <= 0xd7) { pos += 2; continue; }
        const segLen = (buf[pos + 2] << 8) | buf[pos + 3];
        const isSOF = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) {
          const height = (buf[pos + 5] << 8) | buf[pos + 6];
          const width = (buf[pos + 7] << 8) | buf[pos + 8];
          if (width > 0 && height > 0) return { width, height };
          return null;
        }
        pos += 2 + segLen;
      }
      return null;
    }

    return null; // unsupported format (e.g. webp) — caller falls back gracefully
  } catch (e) {
    return null;
  }
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
    if (Array.isArray(product.image_urls) && product.image_urls.length) image = product.image_urls[0];
    else if (typeof product.image_url === 'string') image = product.image_url;
  } catch (e) { /* noop */ }
  if (image && !image.startsWith('http')) image = `${SITE_URL}/${image.replace(/^\//, '')}`;
  const imageDims = image ? await getImageDimensions(image) : null;

  // WhatsApp's link-preview crawler is much stricter than Facebook's Sharing
  // Debugger about image weight/dimensions — very large source photos (e.g.
  // 2500x2500 originals) get silently dropped by WhatsApp even though the
  // Facebook debugger renders them fine. Route the preview image through a
  // free resize/compress proxy (images.weserv.nl) capped at 1200px on the
  // long edge and re-encoded as a quality-80 JPEG, so previews stay small
  // and reliable regardless of how large the original product photo is.
  // The original, full-quality image is untouched everywhere else on site.
  let ogImage = image;
  let ogImageDims = imageDims;
  if (image) {
    ogImage = `https://images.weserv.nl/?url=${encodeURIComponent(image)}&w=1200&h=1200&fit=inside&output=jpg&q=80`;
    if (imageDims && imageDims.width && imageDims.height) {
      const scale = Math.min(1, 1200 / Math.max(imageDims.width, imageDims.height));
      ogImageDims = {
        width: Math.round(imageDims.width * scale),
        height: Math.round(imageDims.height * scale)
      };
    }
  }

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

  // This page is served at /product/{id}, but the HTML (borrowed as-is from
  // index.html) uses relative paths like "assets/logo.png" or "licenses.html".
  // Without a <base> tag those resolve against /product/{id}/ instead of the
  // site root, breaking the logo, hero video, nav links, cart icon, etc.
  // Injecting <base href="SITE_URL/"> fixes every relative URL on the page
  // in one shot, with no other markup changes needed.
  html = html.replace(
    /<head>/,
    `<head>\n<base href="${SITE_URL}/">`
  );

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
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:secure_url" content="${escapeHtml(ogImage)}">
<meta property="og:image:type" content="image/jpeg">` : ''}
${ogImageDims ? `<meta property="og:image:width" content="${ogImageDims.width}">
<meta property="og:image:height" content="${ogImageDims.height}">` : ''}
${ogImage ? `<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description).slice(0, 200)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">` : ''}
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
