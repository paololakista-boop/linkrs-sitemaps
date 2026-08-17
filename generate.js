// Genereert sitemaps voor linkrsmarokko.com uit de publieke API — geen secrets.
// Draait elk uur via GitHub Actions; GitHub Pages serveert het resultaat op
// sitemap.linkrsmarokko.com.
//
// Twee bestanden:
//   news-sitemap.xml — Google News, alleen de laatste 48 uur (News-eis)
//   sitemap.xml      — ALLE gepubliceerde artikelen + blogs, voor gewone indexering
//
// Waarom die tweede: de sitemap van de site zelf (linkrsmarokko.com/sitemap.xml)
// staat sinds 25-06-2026 stil — alles wat daarna is gepubliceerd (honderden
// artikelen) ontbreekt erin, en de nieuwsoverzichtspagina laadt haar lijst pas
// via JavaScript. Zonder deze sitemap heeft Google dus geen betrouwbare manier
// om nieuwe artikelen te vinden. Los daarvan blijft het advies staan dat de
// frontend zijn eigen sitemap weer vers maakt.
import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const BASE = "https://linkrsmarokko-webapp-backend-nwvh3.ondigitalocean.app/api";
// De site draait op www (apex geeft 307 naar www) — sitemaps moeten de
// definitieve, niet-doorverwijzende URL's bevatten.
const SITE = "https://www.linkrsmarokko.com";
const PUBLICATION = "Linkrs Marokko";
const WINDOW_H = 48; // Google News: alleen artikelen van de afgelopen 48 uur
const MAX_URLS = 1000;
const STATIC_PAGES = ["/", "/nieuws", "/blogs", "/vacatures", "/over-ons", "/contact"];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

async function fetchList(path) {
  const res = await fetch(`${BASE}/${path}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`GET /${path} gaf ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.data || [];
}

// De publieke endpoints geven alleen gepubliceerd werk terug; de statuscheck is
// een extra zekerheid zodat er nooit een concept in de sitemap belandt.
const isLive = (a) => a.slug && a.title && (!a.status || a.status === "PUBLISHED");
const dateOf = (a) => new Date(a.publishedAt || a.updatedAt || a.createdAt || Date.now());

const [news, blogs] = await Promise.all([
  fetchList("news"),
  fetchList("blogs").catch((e) => {
    console.warn(`[sitemap] blogs overslaan: ${e.message}`);
    return [];
  }),
]);

// --- 1. Google News-sitemap: laatste 48 uur ---------------------------------
const cutoff = Date.now() - WINDOW_H * 3600 * 1000;
const recent = news
  .filter(isLive)
  .map((a) => ({ ...a, _date: dateOf(a) }))
  .filter((a) => a._date.getTime() > cutoff)
  .sort((a, b) => b._date - a._date)
  .slice(0, MAX_URLS);

const newsUrls = recent
  .map(
    (a) => `  <url>
    <loc>${SITE}/nieuws/${esc(a.slug)}</loc>
    <news:news>
      <news:publication>
        <news:name>${PUBLICATION}</news:name>
        <news:language>nl</news:language>
      </news:publication>
      <news:publication_date>${a._date.toISOString()}</news:publication_date>
      <news:title>${esc(a.title)}</news:title>
    </news:news>${a.imageUrl ? `\n    <image:image><image:loc>${esc(a.imageUrl)}</image:loc></image:image>` : ""}
  </url>`
  )
  .join("\n");

writeFileSync(
  "news-sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:news="http://www.google.com/schemas/sitemap-news/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${newsUrls}
</urlset>
`
);

// --- 2. Volledige sitemap: alles wat live staat -----------------------------
const entry = (loc, lastmod, changefreq, priority, image) =>
  `  <url>
    <loc>${esc(loc)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>${image ? `\n    <image:image><image:loc>${esc(image)}</image:loc></image:image>` : ""}
  </url>`;

const liveNews = news.filter(isLive).sort((a, b) => dateOf(b) - dateOf(a));
const liveBlogs = blogs.filter(isLive).sort((a, b) => dateOf(b) - dateOf(a));

const allUrls = [
  ...STATIC_PAGES.map((p) => entry(`${SITE}${p}`, null, p === "/" ? "daily" : "daily", p === "/" ? "1.0" : "0.9")),
  ...liveNews.map((a) =>
    // Nieuws veroudert snel: recente artikelen krijgen voorrang bij het crawlen.
    entry(`${SITE}/nieuws/${a.slug}`, dateOf(a).toISOString(), "daily",
      Date.now() - dateOf(a).getTime() < 7 * 864e5 ? "0.8" : "0.5", a.imageUrl)
  ),
  ...liveBlogs.map((a) =>
    // Blogs zijn evergreen: blijvend relevant, maar veranderen zelden.
    entry(`${SITE}/blogs/${a.slug}`, dateOf(a).toISOString(), "weekly", "0.7", a.imageUrl)
  ),
].join("\n");

writeFileSync(
  "sitemap.xml",
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${allUrls}
</urlset>
`
);

// --- 3. Korte deel-links: s/<code> ------------------------------------------
// WhatsApp-links krijgen UTM-parameters (~70 tekens extra); op een status duwt
// zo'n lange URL de link achter de "lees meer"-vouw. Openbare verkorters
// (is.gd, TinyURL) worden door WhatsApp sneller als spam aangemerkt — een
// subdomein van het eigen domein niet. Daarom serveert dit repo per artikel een
// mini-doorstuurpagina. De code is een DETERMINISTISCHE hash van sectie+slug:
// de nieuws-bot berekent dezelfde code zelfstandig (src/utm.js in dat repo),
// zonder dat de twee repo's met elkaar hoeven te praten. De UTM-waarden komen
// uit de query (?d=bestemming&c=campagne) zodat één pagina alle kanalen dekt.
const shortCode = (sectie, slug) => createHash("md5").update(`${sectie}/${slug}`).digest("hex").slice(0, 8);

// Vers opbouwen zodat verouderde links vanzelf verdwijnen. Alleen de STATUS
// gebruikt korte links en die leeft 24 uur, dus 45 dagen nieuws is ruim.
rmSync("s", { recursive: true, force: true });
const SHORT_NEWS_DAYS = 45;
const shortItems = [
  ...liveBlogs.map((a) => ({ sectie: "blogs", ...a })),
  ...liveNews
    .filter((a) => Date.now() - dateOf(a).getTime() < SHORT_NEWS_DAYS * 864e5)
    .map((a) => ({ sectie: "nieuws", ...a })),
];
const codesGezien = new Set();
let kortGeschreven = 0;
for (const it of shortItems) {
  const code = shortCode(it.sectie, it.slug);
  if (codesGezien.has(code)) {
    console.warn(`[short] hash-botsing op ${code} (${it.sectie}/${it.slug}) — overgeslagen.`);
    continue;
  }
  codesGezien.add(code);
  const doel = `${SITE}/${it.sectie}/${it.slug}`;
  // OG-tags van het ARTIKEL op de doorstuurpagina: WhatsApp's preview-crawler
  // volgt geen JavaScript, dus zonder deze tags zou de korte link een kale kaart
  // tonen. Met titel, omschrijving en foto ziet het voorbeeld eruit als het
  // artikel zelf.
  const omschrijving = (it.excerpt || it.metaDescription || "").slice(0, 200);
  mkdirSync(`s/${code}`, { recursive: true });
  writeFileSync(
    `s/${code}/index.html`,
    `<!doctype html><html lang="nl"><head><meta charset="utf-8">
<title>${esc(it.title)}</title>
<meta property="og:site_name" content="Linkrs Marokko">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(it.title)}">${omschrijving ? `\n<meta property="og:description" content="${esc(omschrijving)}">` : ""}${it.imageUrl ? `\n<meta property="og:image" content="${esc(it.imageUrl)}">` : ""}
<meta property="og:url" content="${doel}">
<script>var p=new URLSearchParams(location.search);location.replace(${JSON.stringify(doel)}+"?utm_source=whatsapp&utm_medium=social&utm_campaign="+encodeURIComponent(p.get("c")||"nieuws")+"&utm_content="+encodeURIComponent(p.get("d")||"status"));</script>
<meta http-equiv="refresh" content="1;url=${doel}">
</head><body><p><a href="${doel}">Doorgaan naar linkrsmarokko.com</a></p></body></html>`
  );
  kortGeschreven += 1;
}
console.log(`s/: ${kortGeschreven} korte deel-links (blogs + nieuws laatste ${SHORT_NEWS_DAYS}d).`);

writeFileSync(
  "index.html",
  `<!doctype html><meta charset="utf-8"><title>Linkrs Marokko sitemaps</title>
<p>Sitemaps voor <a href="https://www.linkrsmarokko.com">linkrsmarokko.com</a>, elk uur ververst:</p>
<ul>
  <li><a href="/news-sitemap.xml">news-sitemap.xml</a> (Google News, laatste 48u) &mdash; ${recent.length} artikelen</li>
  <li><a href="/sitemap.xml">sitemap.xml</a> (alles) &mdash; ${liveNews.length} artikelen, ${liveBlogs.length} blogs</li>
</ul>
<p>Laatst bijgewerkt: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</p>`
);

console.log(`news-sitemap.xml: ${recent.length} artikelen (laatste ${WINDOW_H}u).`);
console.log(`sitemap.xml: ${liveNews.length} artikelen + ${liveBlogs.length} blogs + ${STATIC_PAGES.length} vaste pagina's.`);
