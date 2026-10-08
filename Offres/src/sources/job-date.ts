/**
 * Dates de publication et de dernière modification d'une offre lue sur le site
 * d'une entreprise. La page carrières ne les donne presque jamais, mais la page
 * de l'offre les porte souvent :
 *  1. JSON-LD `JobPosting.datePosted` ;
 *  2. balises `article:published_time` / `article:modified_time`, ou
 *     `datePublished` / `dateModified` du JSON-LD de la page ;
 *  3. sur un site WordPress, les dates de la page dans l'API du site ;
 *  4. à défaut de date de modification, celle du plan du site (`lastmod`) ;
 *  5. page sans aucune date : en-tête Last-Modified. Il suit souvent le cache du
 *     site plutôt que le contenu, mais le contenu servi n'a pas changé depuis ;
 *  6. offre publiée en PDF : date du fichier (en-tête Last-Modified).
 *
 * Les dates d'une page HTML ne sont retenues que si la page est bien celle de
 * l'offre (son titre reprend l'intitulé). D'une page commune à plusieurs offres
 * (page carrières, liste), seule la date de modification est gardée : tant que
 * la page n'a pas changé, les offres qu'elle porte y étaient déjà. Ne lève jamais.
 */
import { htmlToText, parseJobPostings } from "./careers.js";

export interface JobDate {
  posted_at: number | null; // null : la page ne donne pas de date fiable
  modified_at: number | null; // dernière modification de la page (un simple correctif compte aussi), null si inconnue
  read: boolean; // false : page illisible (panne, anti-robot) — à retenter plus tard
}

const TIMEOUT = 10000;
const MAX_HTML = 3_000_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function get(url: string, accept: string): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    headers: { "user-agent": USER_AGENT, accept, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

/** Date ISO (« 2026-08-05T09:51:44+00:00 ») → ms ; les autres formats sont ambigus (jour / mois), donc ignorés. */
function isoDate(v: string | null | undefined): number | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}/.test(v.trim())) return null;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) && t <= Date.now() ? t : null;
}

function metaContent(html: string, name: string): string | null {
  const tag = html.match(new RegExp(`<meta\\b[^>]*\\b(?:property|name|itemprop)\\s*=\\s*["']${name}["'][^>]*>`, "i"))?.[0];
  return tag?.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
}

const words = (s: string): string[] =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);

/** La page est-elle celle de cette offre ? Son titre (title, h1, og:title) doit reprendre l'essentiel de l'intitulé. */
export function isPageOf(html: string, title: string): boolean {
  const wanted = words(title);
  if (!wanted.length) return false;
  const headings = [
    html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1],
    metaContent(html, "og:title"),
    ...[...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].slice(0, 3).map((m) => m[1]),
  ];
  const seen = words(headings.map((h) => htmlToText(h, 500) ?? "").join(" "));
  // mots collés ou accordés autrement (« back-end » / « backend », « système » / « systèmes ») : un mot long peut n'être qu'une partie du titre
  const joined = seen.join("");
  const found = wanted.filter((w) => seen.includes(w) || (w.length >= 4 && joined.includes(w)));
  return found.length >= Math.ceil(wanted.length * 0.6);
}

/** Date d'une clé du JSON embarqué, si elle est unique : plusieurs dates différentes = liste d'articles, aucune ne désigne la page elle-même. */
function jsonDate(html: string, key: string): number | null {
  const found = new Set(
    [...html.matchAll(new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`, "g"))].map((m) => isoDate(m[1])).filter((t): t is number => t !== null)
  );
  return found.size === 1 ? [...found][0] : null;
}

/** Dates de la page dans l'API WordPress, quand la page y renvoie (`<link rel="alternate" type="application/json">`). */
async function wordpressDates(html: string, pageUrl: string): Promise<{ posted_at: number | null; modified_at: number | null }> {
  const none = { posted_at: null, modified_at: null };
  const tag = html.match(/<link\b[^>]*\bhref\s*=\s*["'][^"']*\/wp-json\/wp\/v2\/[^"']+["'][^>]*>/i)?.[0];
  const href = tag?.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!href) return none;
  try {
    const res = await get(new URL(href.replace(/&amp;/g, "&"), pageUrl).href, "application/json");
    if (!res.ok) return none;
    const post = (await res.json()) as { date_gmt?: string; date?: string; modified_gmt?: string; modified?: string };
    return {
      posted_at: isoDate(post.date_gmt ? `${post.date_gmt}Z` : post.date),
      modified_at: isoDate(post.modified_gmt ? `${post.modified_gmt}Z` : post.modified),
    };
  } catch {
    return none;
  }
}

// ── Plan du site ──────────────────────────────────────────────────────────────
const SITEMAP_MAX_FILES = 25;
const SITEMAP_TTL = 60 * 60 * 1000; // les offres d'un même site sont lues à la suite : un seul passage sur son plan
const sitemaps = new Map<string, { at: number; pages: Promise<Map<string, number>> }>();

/** Clé de rapprochement d'une URL avec celles du plan du site : sans protocole, « www » ni barre finale. */
function pageKey(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + decodeURIComponent(u.pathname).replace(/\/+$/, "").toLowerCase() + u.search;
  } catch {
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await get(url, "application/xml,text/xml,text/plain,*/*");
    return res.ok ? (await res.text()).slice(0, MAX_HTML) : null;
  } catch {
    return null;
  }
}

const locOf = (entry: string): string | null =>
  entry.match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i)?.[1]?.replace(/&amp;/g, "&") ?? null;

/** Date de modification (`lastmod`) de chaque page annoncée par le plan d'un site. */
async function readSitemap(origin: string): Promise<Map<string, number>> {
  const pages = new Map<string, number>();
  const robots = await getText(`${origin}/robots.txt`);
  const queue = [
    ...(robots?.match(/^sitemap:\s*\S+/gim) ?? []).map((l) => l.replace(/^sitemap:\s*/i, "")),
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
  ];
  const seen = new Set<string>();
  let files = 0;
  while (queue.length && files < SITEMAP_MAX_FILES) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const xml = await getText(url);
    if (!xml || !/<(urlset|sitemapindex)\b/i.test(xml)) continue;
    files++;
    for (const m of xml.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/gi)) {
      const loc = locOf(m[1]);
      if (loc) queue.push(loc);
    }
    const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)].map((m) => ({
      key: pageKey(locOf(m[1]) ?? ""),
      lastmod: m[1].match(/<lastmod>\s*([^<\s]+)/i)?.[1] ?? null,
    }));
    // une même date sur la plupart des pages est celle de la génération du plan, pas d'une modification
    const counts = new Map<string, number>();
    for (const e of entries) if (e.lastmod) counts.set(e.lastmod, (counts.get(e.lastmod) ?? 0) + 1);
    for (const e of entries) {
      const t = isoDate(e.lastmod);
      if (!e.key || t === null) continue;
      if (entries.length >= 5 && counts.get(e.lastmod!)! > entries.length / 2) continue;
      pages.set(e.key, t);
    }
  }
  return pages;
}

async function sitemapDate(url: string): Promise<number | null> {
  const key = pageKey(url);
  if (!key) return null;
  const origin = new URL(url).origin;
  for (const [o, s] of sitemaps) if (Date.now() - s.at > SITEMAP_TTL) sitemaps.delete(o);
  let site = sitemaps.get(origin);
  if (!site) sitemaps.set(origin, (site = { at: Date.now(), pages: readSitemap(origin) }));
  return (await site.pages).get(key) ?? null;
}

/** `title` : intitulé de l'offre, ou null si la page est commune à plusieurs offres. */
export async function fetchJobDate(url: string, title: string | null): Promise<JobDate> {
  let html: string;
  let pageUrl: string;
  let served: number | null;
  try {
    const res = await get(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    // page disparue : rien à retenter ; refus ou panne : on repassera
    if (res.status === 404 || res.status === 410) return { posted_at: null, modified_at: null, read: true };
    if (!res.ok) return { posted_at: null, modified_at: null, read: false };
    const type = res.headers.get("content-type") ?? "";
    const stamp = Date.parse(res.headers.get("last-modified") ?? "");
    served = Number.isFinite(stamp) && stamp <= Date.now() ? stamp : null;
    if (!/html/i.test(type)) {
      await res.body?.cancel().catch(() => {});
      // un PDF remplacé change de date : la première lue reste la publication, les suivantes sont des modifications
      const filed = /pdf/i.test(type) && title !== null ? served : null;
      return { posted_at: filed, modified_at: filed, read: true };
    }
    html = (await res.text()).slice(0, MAX_HTML);
    pageUrl = res.url || url;
  } catch {
    return { posted_at: null, modified_at: null, read: false };
  }
  if (title !== null && !isPageOf(html, title)) return { posted_at: null, modified_at: null, read: true };

  const postings = parseJobPostings(html, pageUrl);
  const structured = postings.length === 1 && postings[0].posted_at !== null && postings[0].posted_at <= Date.now() ? postings[0].posted_at : null;
  let posted =
    structured ?? isoDate(metaContent(html, "datePosted")) ?? isoDate(metaContent(html, "article:published_time")) ?? jsonDate(html, "datePublished");
  let modified =
    isoDate(metaContent(html, "article:modified_time")) ?? isoDate(metaContent(html, "og:updated_time")) ?? jsonDate(html, "dateModified");
  if (posted === null || modified === null) {
    const wp = await wordpressDates(html, pageUrl);
    posted ??= wp.posted_at;
    modified ??= wp.modified_at;
  }
  modified ??= await sitemapDate(pageUrl);
  if (title === null) {
    // liste d'offres : la date d'édition de la page peut ignorer une liste générée à part, le contenu servi non
    const last = Math.max(modified ?? 0, served ?? 0);
    return { posted_at: null, modified_at: last > 0 ? last : null, read: true };
  }
  if (posted === null) modified ??= served;
  if (posted !== null && modified !== null && modified < posted) modified = null;
  return { posted_at: posted, modified_at: modified, read: true };
}
