// Dynamic sitemap generator — Vercel Serverless Function
// Pulls the live product list from Supabase every time Google (or anyone)
// requests the sitemap, so new products are discoverable automatically —
// no manual sitemap editing needed ever again.

const SUPABASE_URL = 'https://rzibqgnhzphlmjkzwota.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_CQawBi0OPWWHKBIUnHr1Dg_OK4cuKIh';
const SITE_URL = 'https://nfsupplementstore.com';

function escapeXml(str){
  return String(str || '').replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

module.exports = async function handler(req, res){
  let products = [];
  try{
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/products?select=id,updated_at,created_at&order=created_at.desc`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if(resp.ok) products = await resp.json();
  }catch(e){
    // If Supabase is unreachable, still serve the static pages below rather than failing entirely
    products = [];
  }

  const staticPages = [
    { loc: `${SITE_URL}/`, changefreq: 'daily', priority: '1.0' },
    { loc: `${SITE_URL}/shipping-policy.html`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${SITE_URL}/refund-policy.html`, changefreq: 'monthly', priority: '0.3' },
    { loc: `${SITE_URL}/licenses.html`, changefreq: 'monthly', priority: '0.3' }
  ];

  const productUrls = (products || []).map(p => {
    const lastmod = (p.updated_at || p.created_at || '').slice(0, 10);
    return `  <url>
    <loc>${escapeXml(`${SITE_URL}/product/${p.id}`)}</loc>
    ${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
  });

  const staticUrls = staticPages.map(p => `  <url>
    <loc>${escapeXml(p.loc)}</loc>
    <changefreq>${p.changefreq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticUrls, ...productUrls].join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.status(200).send(xml);
};
