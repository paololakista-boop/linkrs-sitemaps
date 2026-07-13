// Genereert een Google News-sitemap voor linkrsmarokko.com/nieuws.
// Draait elk uur via GitHub Actions; GitHub Pages serveert het resultaat op
// sitemap.linkrsmarokko.com. Gebruikt alleen de publieke API — geen secrets.
import { writeFileSync } from "node:fs";

const API = "https://linkrsmarokko-webapp-backend-nwvh3.ondigitalocean.app/api/news";
const SITE = "https://www.linkrsmarokko.com/nieuws";
const PUBLICATION = "Linkrs Marokko";
const WINDOW_H = 48; // Google News: alleen artikelen van de afgelopen 48 uur
const MAX_URLS = 1000;

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const res = await fetch(API, { signal: AbortSignal.timeout(60000) });
if (!res.ok) throw new Error(`API gaf ${res.status}`);
const data = await res.json();
const all = Array.isArray(data) ? data : data.data || [];

const cutoff = Date.now() - WINDOW_H * 3600 * 1000;
const recent = all
  .filter((a) => a.slug && a.title)
  .map((a) => ({ ...a, _date: new Date(a.publishedAt || a.createdAt) }))
  .filter((a) => a._date.getTime() > cutoff)
  .sort((a, b) => b._date - a._date)
  .slice(0, MAX_URLS);

const urls = recent
  .map(
    (a) => `  <url>
    <loc>${SITE}/${esc(a.slug)}</loc>
    <news:news>
      <news:publication>
        <news:name>${PUBLICATION}</news:name>
        <news:language>nl</news:language>
      </news:publication>
      <news:publication_date>${a._date.toISOString()}</news:publication_date>
      <news:title>${esc(a.title)}</news:title>
    </news:news>
  </url>`
  )
  .join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
${urls}
</urlset>
`;

writeFileSync("news-sitemap.xml", xml);
writeFileSync(
  "index.html",
  `<!doctype html><meta charset="utf-8"><title>Linkrs Marokko sitemaps</title>
<p>Sitemaps voor <a href="https://www.linkrsmarokko.com">linkrsmarokko.com</a>:</p>
<ul><li><a href="/news-sitemap.xml">news-sitemap.xml</a> (Google News, laatste 48u)</li></ul>`
);
console.log(`news-sitemap.xml: ${recent.length} artikelen (laatste ${WINDOW_H}u).`);
