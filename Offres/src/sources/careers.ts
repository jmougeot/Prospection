/**
 * Détection des offres d'une entreprise à partir de son seul nom de domaine :
 *  1. page d'accueil → lien « carrières » (ou, à défaut, quelques chemins usuels) ;
 *  2. sur ces deux pages, toutes les URL pointant vers un ATS connu (lien, iframe,
 *     script, JSON embarqué) : renvoyées brutes, l'intégration les passe ensuite à
 *     parseBoardRef et aux lecteurs des autres ATS ;
 *  3. offres publiées sur le site lui-même en JSON-LD schema.org `JobPosting`
 *     (page carrières, puis quelques pages d'offre qu'elle référence).
 *
 * Pas de navigateur : une page rendue uniquement en JavaScript ne donne rien ici.
 * Ne lève jamais : toute panne finit dans `error`.
 */
import { type Posting } from "../ats.js";

export interface CareersResult {
  domain: string;
  careersUrl: string | null; // page carrières trouvée (URL finale après redirections), null sinon
  atsUrls: string[]; // URL brutes pointant vers un ATS connu, dédoublonnées
  postings: Posting[]; // offres lues dans le JSON-LD JobPosting du site
  error: string | null;
  // moteur de la page carrières reconnu à sa signature quand elle vit sur un domaine
  // de l'entreprise (« teamtailor » pour careers.exemple.com, « odoo »…), null sinon
  platform: string | null;
  // liens de la page carrières qui ressemblent à des pages d'offre (intitulé = texte du
  // lien). Signal faible, sans lieu ni date : utile quand le site n'a ni ATS ni JSON-LD.
  jobLinks: Array<{ url: string; title: string }>;
}

const TIMEOUT = 10000;
const DOMAIN_BUDGET = 60000; // durée maximale consacrée à un domaine
const MAX_HTML = 3_000_000;
const DESCRIPTION_MAX = 8000;
const MAX_JOB_PAGES = 15;
const JOB_PAGE_CONCURRENCY = 3;
const BLIND_JOB_PAGES = 3; // pages d'offre lues avant de conclure que le site n'a pas de JSON-LD
const MAX_PROBES = 6;
const MAX_ATS_URLS = 60; // au-delà, ce sont les mêmes pages d'offre répétées
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ── ATS connus ────────────────────────────────────────────────────────────────
// `host` : motif sur le nom d'hôte ; `path` : exigé en plus quand l'hôte seul ne
// suffit pas (site vitrine de l'ATS, plateforme multi-usages).
interface AtsHost {
  name: string;
  host: RegExp;
  path?: RegExp;
}
const ATS_HOSTS: AtsHost[] = [
  { name: "greenhouse", host: /(^|\.)(greenhouse\.io|grnh\.se)$/ },
  { name: "lever", host: /(^|\.)lever\.co$/ },
  { name: "ashby", host: /(^|\.)ashbyhq\.com$/ },
  { name: "smartrecruiters", host: /(^|\.)smartrecruiters\.com$/ },
  { name: "workable", host: /(^|\.)workable\.com$/ },
  { name: "teamtailor", host: /(^|\.)teamtailor\.com$/ },
  { name: "recruitee", host: /(^|\.)recruitee\.com$/ },
  { name: "personio", host: /(^|\.)personio\.(de|com)$/ },
  { name: "welcometothejungle", host: /(^|\.)welcometothejungle\.com$/, path: /\/companies[^/]*\/[^/]+/ },
  { name: "welcomekit", host: /(^|\.)welcomekit\.co$/ },
  { name: "taleez", host: /(^|\.)taleez\.com$/ },
  { name: "flatchr", host: /(^|\.)flatchr\.io$/ },
  { name: "bamboohr", host: /(^|\.)bamboohr\.com$/ },
  { name: "breezy", host: /(^|\.)breezy\.hr$/ },
  { name: "jazzhr", host: /(^|\.)(applytojob\.com|jazz\.co|jazzhr\.com)$/ },
  { name: "join", host: /^(www\.)?join\.com$/, path: /^\/(companies|embed)\/[^/]+/ },
  { name: "pinpoint", host: /(^|\.)pinpointhq\.com$/ },
  { name: "workday", host: /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/ },
  { name: "jobvite", host: /(^|\.)jobvite\.com$/ },
  { name: "factorial", host: /(^|\.)factorialhr\.(com|fr|es)$/ },
  // Notion sert à tout (kit presse, doc…) : seules les pages au nom évocateur comptent
  { name: "notion", host: /(^|\.)notion\.site$/, path: /job|career|recrut|hiring|join|rejoin|carri|emploi|talent|work-?(with|at)|open-?(roles|positions)|offres/i },
  { name: "digitalrecruiters", host: /(^|\.)digitalrecruiters\.com$/ },
  { name: "jobaffinity", host: /(^|\.)jobaffinity\.fr$/ },
  { name: "talentsoft", host: /(^|\.)talent-soft\.com$/ },
  { name: "icims", host: /(^|\.)icims\.com$/ },
  { name: "successfactors", host: /(^|\.)successfactors\.(com|eu)$/ },
  { name: "beetween", host: /(^|\.)beetween\.com$/ },
  { name: "werecruit", host: /(^|\.)werecruit\.io$/ },
  { name: "rippling", host: /^ats\.rippling\.com$/ },
  { name: "homerun", host: /(^|\.)homerun\.co$/ },
  { name: "manatal", host: /(^|\.)careers-page\.com$/ },
  { name: "zohorecruit", host: /(^|\.)zohorecruit\.(com|eu)$/ },
  { name: "softgarden", host: /(^|\.)softgarden\.(io|de)$/ },
  { name: "jobylon", host: /(^|\.)jobylon\.com$/ },
  { name: "lucca", host: /(^|\.)jobs\.[a-z0-9-]+\.luccasoftware\.com$/ },
  { name: "hirello", host: /(^|\.)hirello\.fr$/ },
  { name: "hrmaps", host: /(^|\.)(nicoka|eolia-software|inrecruiting|talentview)\.(com|io|fr)$/ },
];
// sous-domaines qui ne désignent jamais la page d'un client (site vitrine, doc, aide…)
const ATS_GENERIC_SUB = /^(www|help|support|docs?|developers?|blog|status|info|resources|get|try|marketing|academy|community|go|hello|partners?)\./;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|eot|mp4|webm|pdf)$/i;

/** Nom de l'ATS auquel appartient une URL (« teamtailor », « greenhouse »…), ou null. */
export function atsNameOfUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  for (const a of ATS_HOSTS) {
    if (!a.host.test(host)) continue;
    if (a.path) return a.path.test(u.pathname) ? a.name : null;
    // domaine nu ou sous-domaine générique sans chemin utile : site vitrine de l'ATS
    const bare = host.split(".").length === 2 || ATS_GENERIC_SUB.test(host);
    if (bare && (ATS_GENERIC_SUB.test(host) || u.pathname.replace(/\/+$/, "") === "")) return null;
    return a.name;
  }
  return null;
}

// Une seule expression pour repérer, dans le HTML brut, toute URL d'un hôte ATS.
const ATS_URL_RE = new RegExp(
  String.raw`(?:https?:)?//(?:[a-z0-9-]+\.)*(?:` +
    [
      "greenhouse\\.io", "grnh\\.se", "lever\\.co", "ashbyhq\\.com", "smartrecruiters\\.com", "workable\\.com",
      "teamtailor\\.com", "recruitee\\.com", "personio\\.(?:de|com)", "welcometothejungle\\.com", "welcomekit\\.co",
      "taleez\\.com", "flatchr\\.io", "bamboohr\\.com", "breezy\\.hr", "applytojob\\.com", "jazz\\.co", "jazzhr\\.com",
      "join\\.com", "pinpointhq\\.com", "myworkdayjobs\\.com", "myworkdaysite\\.com", "jobvite\\.com",
      "factorialhr\\.(?:com|fr|es)", "notion\\.site", "digitalrecruiters\\.com", "jobaffinity\\.fr", "talent-soft\\.com",
      "icims\\.com", "successfactors\\.(?:com|eu)", "beetween\\.com", "werecruit\\.io", "rippling\\.com", "homerun\\.co",
      "careers-page\\.com", "zohorecruit\\.(?:com|eu)", "softgarden\\.(?:io|de)", "jobylon\\.com", "nicoka\\.com",
      "eolia-software\\.com", "inrecruiting\\.com", "talentview\\.io", "luccasoftware\\.com", "hirello\\.fr",
    ].join("|") +
    String.raw`)(?![a-z0-9.-])[^\s"'<>\\)\]}|^` + "`" + String.raw`]*`,
  "gi"
);

// ── Petits utilitaires ────────────────────────────────────────────────────────
type Obj = Record<string, any>;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML (éventuellement échappé en entités) → texte brut tronqué. Même logique que dans ats.ts. */
export function htmlToText(html: string | null | undefined, max = DESCRIPTION_MAX): string | null {
  if (!html) return null;
  const raw = /<[a-z]/i.test(html) ? html : decodeEntities(html);
  const text = decodeEntities(
    raw
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text ? text.slice(0, max) : null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const date = (v: unknown): number | null => {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
const errMsg = (err: unknown): string => {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "délai dépassé";
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
};

interface Page {
  url: string; // URL finale, après redirections
  status: number;
  html: string; // vide si la réponse n'est pas du HTML
}

async function fetchPage(url: string, deadline: number): Promise<Page> {
  const left = deadline - Date.now();
  if (left <= 500) throw new Error("budget de temps épuisé");
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
    },
    signal: AbortSignal.timeout(Math.min(TIMEOUT, left)),
  });
  const type = res.headers.get("content-type") ?? "";
  if (type && !/html|xml|text\/plain/i.test(type)) {
    await res.body?.cancel().catch(() => {});
    return { url: res.url || url, status: res.status, html: "" };
  }
  const html = (await res.text()).slice(0, MAX_HTML);
  return { url: res.url || url, status: res.status, html };
}

/** Page protégée par un anti-robot (Cloudflare, DataDome…) : inutile d'insister. */
function isBlocked(p: Page): boolean {
  if ([401, 403, 429, 503].includes(p.status)) return true;
  return p.html.length < 20000 && /just a moment|attention required|captcha-delivery|cf-chl-|access denied|are you a robot|datadome/i.test(p.html);
}

// ── Liens d'une page ──────────────────────────────────────────────────────────
interface Link {
  url: string;
  text: string;
}

function baseOf(page: Page): string {
  const m = /<base[^>]+href\s*=\s*["']([^"']+)["']/i.exec(page.html);
  if (!m) return page.url;
  try {
    return new URL(decodeEntities(m[1]), page.url).href;
  } catch {
    return page.url;
  }
}

function extractLinks(page: Page): Link[] {
  const base = baseOf(page);
  const out: Link[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(page.html))) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const raw = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    let url: string;
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      url = u.href;
    } catch {
      continue;
    }
    const label = /\b(?:aria-label|title)\s*=\s*"([^"]*)"/i.exec(m[1])?.[1] ?? "";
    const text = (htmlToText(m[2], 200) ?? "") || decodeEntities(label);
    out.push({ url, text: text.replace(/\s+/g, " ").trim() });
  }
  return out;
}

// ── Recherche de la page carrières ────────────────────────────────────────────
const CAREERS_TEXT =
  /\b(careers?|jobs?|join (us|the team|our team)|work (with|at|for) (us|\w+)|we('| a)?re hiring|hiring|open (positions|roles)|vacancies|recrutement|recrute(r|z)?|on recrute|nous recrutons|carrieres?|nous rejoindre|rejoignez[- ]nous|rejoindre|rejoins[- ]nous|offres? d'emploi|emplois?|postuler|travailler chez|talents?)\b/;
const CAREERS_TEXT_STRONG =
  /\b(careers?|jobs|join us|we('| a)?re hiring|recrutement|on recrute|nous recrutons|carrieres?|nous rejoindre|rejoignez[- ]nous|offres? d'emploi|open positions)\b/;
const CAREERS_PATH =
  /(^|[/._-])(careers?|jobs?|join(-|_)?(us|the-team|our-team)?|joinus|recrutement|recrute|recruitment|recruiting|carrieres?|nous-rejoindre|rejoignez-nous|rejoindre|rejoins-nous|emplois?|offres-d-emploi|offres-d-?emploi|offres-emploi|on-recrute|we-are-hiring|hiring|work-with-us|talents?|vacancies|open-positions|postuler|stellenangebote|karriere)([/._-]|$)/;
const NOT_CAREERS_PATH =
  /\/(blog|news|actualites?|press|presse|articles?|ressources|resources|podcast|events?|webinars?|case-stud\w+|customers?|clients?|temoignages?|legal|privacy|logiciels?[^/]*|solutions?|produits?|products?|features|fonctionnalites|suite[^/]*|modules?|services?)\//;
const ABOUT = /\b(about|a propos|qui sommes[- ]nous|notre (societe|entreprise|histoire|equipe)|l'equipe|la societe|l'entreprise|company|societe|entreprise|our team|team|equipe)\b/;
const ABOUT_PATH = /(^|[/._-])(about(-us)?|a-propos|qui-sommes-nous|societe|entreprise|company|equipe|team|notre-histoire)([/._-]|$)/;
const SOCIAL_HOST = /(^|\.)(linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|indeed\.com|glassdoor\.[a-z.]+|apec\.fr|hellowork\.com|malt\.fr)$/;
const PROBE_PATHS = ["/careers", "/jobs", "/recrutement", "/carrieres", "/join-us", "/nous-rejoindre"];

/** Domaine enregistrable approximatif (deux derniers segments, trois pour « co.uk » et consorts). */
function registrable(host: string): string {
  const parts = host.toLowerCase().split(".");
  const n = parts.length > 2 && /^(co|com|org|net|gouv|ac)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join(".");
}

function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Liens candidats « carrières » d'une page d'accueil, du plus probable au moins probable. */
function careersCandidates(home: Page): string[] {
  const homeUrl = new URL(home.url);
  const scored = new Map<string, number>();
  for (const link of extractLinks(home)) {
    const u = new URL(link.url);
    const host = u.hostname.toLowerCase();
    if (SOCIAL_HOST.test(host)) continue;
    if (ASSET_EXT.test(u.pathname)) continue;
    const path = norm(decodeURIComponent(u.pathname.replace(/%(?![0-9a-f]{2})/gi, "%25")));
    const text = norm(link.text);
    const sameSite = siteKey(host) === siteKey(homeUrl.hostname) || host.endsWith("." + siteKey(homeUrl.hostname));
    const isAts = atsNameOfUrl(link.url) !== null;
    if (u.pathname.replace(/\/+$/, "") === "" && sameSite && !/^(careers?|jobs?|recrutement|carrieres?|join|emploi)\./.test(host)) continue;
    let score = 0;
    if (text.length <= 60 && CAREERS_TEXT.test(text)) score += CAREERS_TEXT_STRONG.test(text) ? 3 : 2;
    const textHit = score > 0;
    if (CAREERS_PATH.test(path)) {
      // un long titre d'article (« recrutement-de-cadres-a-nice-… ») n'est pas une page carrières
      const last = path.split("/").filter(Boolean).pop() ?? "";
      score += !textHit && (last.length > 28 || last.split("-").length > 4) ? 1 : 3;
    }
    if (/^(careers?|jobs?|recrutement|carrieres?|join|emploi|talents?)\./.test(host)) score += 3;
    if (isAts) score += 3;
    if (score === 0) continue;
    const jobsHost = /^(careers?|jobs?|recrutement|carrieres?|join|emploi|talents?)\./.test(host);
    if (!sameSite && !isAts && !jobsHost) score -= 4; // lien externe quelconque (article, partenaire…)
    if (NOT_CAREERS_PATH.test(path + "/")) score -= 3;
    const depth = u.pathname.split("/").filter(Boolean).length;
    if (depth > 2) score -= depth - 2; // une offre précise ou un article plutôt que la page d'ensemble
    if (score <= 1) continue;
    scored.set(link.url, Math.max(scored.get(link.url) ?? 0, score));
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length).map(([url]) => url);
}

/** Page « à propos / société » de l'accueil : le lien carrières s'y cache souvent. */
function aboutLink(home: Page): string | null {
  const h = new URL(home.url);
  let best: string | null = null;
  for (const link of extractLinks(home)) {
    const u = new URL(link.url);
    if (siteKey(u.hostname) !== siteKey(h.hostname)) continue;
    const path = norm(u.pathname);
    if (path.split("/").filter(Boolean).length > 3 || NOT_CAREERS_PATH.test(path + "/")) continue;
    const text = norm(link.text);
    if (ABOUT_PATH.test(path) || (text.length <= 40 && ABOUT.test(text))) {
      if (!best || link.url.length < best.length) best = link.url;
    }
  }
  return best;
}

/** Une page obtenue par sondage d'un chemin usuel est-elle vraiment une page carrières ? */
function looksLikeCareers(page: Page, home: Page): boolean {
  if (page.status >= 400 || !page.html) return false;
  if (atsNameOfUrl(page.url)) return true;
  const u = new URL(page.url);
  const h = new URL(home.url);
  // renvoi vers l'accueil, ou appli monopage qui sert le même HTML partout
  if (siteKey(u.hostname) === siteKey(h.hostname) && u.pathname.replace(/\/+$/, "") === h.pathname.replace(/\/+$/, "")) return false;
  if (page.html.length === home.html.length || page.html === home.html) return false;
  const title = norm(htmlToText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html)?.[1], 200) ?? "");
  if (/\b(404|not found|introuvable|page non trouvee|oops)\b/.test(title)) return false;
  const h1 = norm(htmlToText(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(page.html)?.[1], 200) ?? "");
  return CAREERS_PATH.test(norm(u.pathname)) || CAREERS_TEXT.test(title) || CAREERS_TEXT.test(h1);
}

// ── URL d'ATS présentes dans une page ─────────────────────────────────────────
function collectAtsUrls(page: Page, into: Set<string>): void {
  if (atsNameOfUrl(page.url)) into.add(page.url);
  if (!page.html) return;
  // URL échappées dans du JSON (« https:\/\/ », « / ») ou en entités HTML
  const html = page.html
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/&(quot|#34|#x22|#39|#x27|apos);/gi, '"')
    .replace(/&#x2f;/gi, "/")
    .replace(/%3A%2F%2F/gi, "://");
  for (const m of html.matchAll(ATS_URL_RE)) {
    let raw = m[0].replace(/[.,;:!?'"]+$/, "");
    if (raw.startsWith("//")) raw = "https:" + raw;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (ASSET_EXT.test(u.pathname) || /\/relationships\//.test(u.pathname)) continue; // relations d'API : pur bruit
    if (/[${}]|%7B|%24/i.test(u.pathname)) continue; // gabarit JavaScript non résolu (« ${SLUG} »)
    if (into.size < MAX_ATS_URLS && atsNameOfUrl(u.href)) into.add(u.href);
  }
}

// Signatures de moteurs servant la page carrières sous le domaine de l'entreprise.
const PLATFORM_SIGNATURES: Array<[string, RegExp]> = [
  ["teamtailor", /teamtailor-cdn\.com|teamtailor\.com\/|name="generator" content="Teamtailor/i],
  ["recruitee", /recruiteecdn\.com|recruitee\.com\//i],
  ["welcomekit", /cdn\.welcomekit\.co|welcomekit\.co\//i],
  ["personio", /personio\.(de|com)\//i],
  ["workable", /workable\.com\/|whr\(document\)/i],
  ["odoo", /website_hr_recruitment|content="Odoo"/i],
  ["wp-job-manager", /job_listing|wp-job-manager/i],
  ["lucca", /luccasoftware\.com/i],
];
function platformOf(page: Page): string | null {
  const byHost = atsNameOfUrl(page.url);
  if (byHost) return byHost;
  for (const [name, re] of PLATFORM_SIGNATURES) if (re.test(page.html)) return name;
  return null;
}

/** Lien de la page carrières vers la liste complète des offres (« /jobs », jobs.exemple.com…). */
function indexLink(careers: Page): string | null {
  const base = new URL(careers.url);
  for (const link of extractLinks(careers)) {
    const u = new URL(link.url);
    const path = norm(u.pathname.replace(/\/+$/, ""));
    if (u.hostname === base.hostname) {
      if (path === base.pathname.replace(/\/+$/, "")) continue;
      if (/\/(jobs|offres|offres-d-?emploi|positions|open-positions|openings|postes|emplois|job-offers|all-jobs|nos-offres-d-?emploi)$/.test(path)) return u.origin + u.pathname;
    } else if (registrable(u.hostname) === registrable(base.hostname) && /^(careers?|jobs?|recrutement|carrieres?|join|emploi)\./.test(u.hostname)) {
      if (path.split("/").filter(Boolean).length <= 2 && !/login|signin|connect/.test(path)) return u.origin + u.pathname;
    }
  }
  return null;
}

// ── JSON-LD JobPosting ────────────────────────────────────────────────────────
function parseJsonLoose(raw: string): unknown {
  const text = raw.replace(/^\s*<!--/, "").replace(/-->\s*$/, "").replace(/^\s*\/\/<!\[CDATA\[/, "").replace(/\/\/\]\]>\s*$/, "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // retours à la ligne et tabulations bruts dans les chaînes (fréquent dans les descriptions)
    try {
      return JSON.parse(text.replace(/[\u0000-\u001f]+/g, " "));
    } catch {
      return null;
    }
  }
}

function findJobPostings(node: unknown, out: Obj[], depth = 0): void {
  if (depth > 8 || node == null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) findJobPostings(n, out, depth + 1);
    return;
  }
  const o = node as Obj;
  if (arr(o["@type"]).some((t) => typeof t === "string" && /(^|[/:])JobPosting$/i.test(t))) {
    out.push(o);
    return;
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") findJobPostings(v, out, depth + 1);
}

const nameOf = (v: unknown): string | null => str(v) ?? str((v as Obj)?.name) ?? str((v as Obj)?.["@id"]);

function toPosting(j: Obj, pageUrl: string): Posting | null {
  const title = htmlToText(str(j.title) ?? str(j.name), 300);
  if (!title) return null;
  let url = pageUrl;
  const rawUrl = str(j.url) ?? str(j["@id"]);
  if (rawUrl) {
    try {
      const u = new URL(rawUrl, pageUrl);
      if (/^https?:$/.test(u.protocol)) url = u.href;
    } catch {
      /* URL illisible : on garde celle de la page */
    }
  }
  const id = j.identifier;
  const identifier = str(id) ?? str(id?.value) ?? str(arr(id)[0]?.value);

  const places: string[] = [];
  const countries: string[] = [];
  for (const loc of arr(j.jobLocation)) {
    const a = typeof loc === "string" ? loc : (loc?.address ?? loc);
    if (typeof a === "string") {
      if (a.trim()) places.push(a.trim());
      continue;
    }
    for (const addr of arr(a)) {
      if (typeof addr === "string") {
        if (addr.trim()) places.push(addr.trim());
        continue;
      }
      const country = nameOf(addr?.addressCountry);
      if (country) countries.push(country);
      const parts = [nameOf(addr?.addressLocality), nameOf(addr?.addressRegion), country].filter(Boolean) as string[];
      const place = [...new Set(parts)].join(", ") || str(loc?.name);
      if (place) places.push(place);
    }
  }
  // télétravail : le pays exigé du candidat tient lieu de localisation
  for (const req of arr(j.applicantLocationRequirements)) {
    const name = nameOf(req) ?? nameOf(req?.address?.addressCountry);
    if (name) {
      if (!places.length) places.push(name);
      countries.push(name);
    }
  }
  const uniq = [...new Set(places)];
  const fr = countries.find((c) => /^(fr|fra|france)$/i.test(c.trim()));

  const category = arr(j.occupationalCategory).map(nameOf).filter(Boolean)[0] ?? null;
  return {
    external_id: identifier ?? url,
    title,
    company: nameOf(j.hiringOrganization),
    department: category && category.length <= 80 ? category : null,
    location: uniq.length ? uniq.join(" · ") : null,
    country: fr ?? countries[0] ?? null, // une offre multi-pays reste « France » si la France y figure
    remote: arr(j.jobLocationType).some((t) => typeof t === "string" && /telecommute|remote/i.test(t)),
    url,
    description: htmlToText(str(j.description)),
    posted_at: date(j.datePosted),
  };
}

/** Offres JobPosting décrites en JSON-LD dans une page. */
export function parseJobPostings(html: string, pageUrl: string): Posting[] {
  const out: Posting[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!/JobPosting/i.test(m[1])) continue;
    const found: Obj[] = [];
    findJobPostings(parseJsonLoose(m[1]) ?? parseJsonLoose(decodeEntities(m[1])), found);
    for (const j of found) {
      const p = toPosting(j, pageUrl);
      if (p) out.push(p);
    }
  }
  return out;
}

// ── Pages d'offre référencées par la page carrières ───────────────────────────
const JOB_PATH =
  /\/(jobs?|careers?|carrieres?|offres?|offres?-d-emploi|offres-emploi|postes?|positions?|openings?|opportunit(y|ies|es)|emplois?|recrutement|annonces?|vacanc(y|ies)|join-us|nous-rejoindre|roles?|o|p)\/[^/?#]{3,}/;
const NOT_JOB_PATH =
  /\/(page|category|categories|tag|tags|departments?|locations?|teams?|search|feed|rss|login|signin|connect|people|pages|posts|blog|show_more|apply|[^/]*(cookie|privacy|confidentialite|mentions-legales|legal|cgu|cgv|contact)[^/]*)(\/|$)|\.(xml|rss|json)$/;

function jobLinks(careers: Page): string[] {
  return jobLinksWithTitle(careers).map((l) => l.url);
}

function jobLinksWithTitle(careers: Page): Array<{ url: string; title: string }> {
  const base = new URL(careers.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string; score: number }> = [];
  for (const link of extractLinks(careers)) {
    const u = new URL(link.url);
    const sameHost = u.hostname === base.hostname;
    // une offre peut vivre sur un sous-domaine voisin (erp.exemple.com, jobs.exemple.com)
    if (!sameHost && registrable(u.hostname) !== registrable(base.hostname)) continue;
    const path = u.pathname.replace(/\/+$/, "");
    if ((sameHost && path === basePath && !u.search) || path === "" || ASSET_EXT.test(path) || NOT_JOB_PATH.test(norm(path))) continue;
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|lang$|lieu$|page$)/i.test(k)) u.searchParams.delete(k);
    if (sameHost && path === basePath && !u.search) continue;
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    // « sous la page carrières » n'a de sens que si celle-ci a un vrai chemin (pas « / » ni « /fr »)
    const under = sameHost && !/^(\/[a-z]{2}(-[a-z]{2})?)?$/i.test(basePath) && (path.startsWith(basePath + "/") || (path === basePath && u.search !== ""));
    const jobby = JOB_PATH.test(norm(path));
    if (!under && !jobby) continue;
    out.push({ url: u.href, title: link.text, score: (under ? 1 : 0) + (jobby ? 1 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).map(({ url, title }) => ({ url, title }));
}

const GENERIC_LINK_TEXT =
  /^(postuler|apply( now)?|en savoir plus|learn more|voir (l'offre|plus|les offres|toutes les offres)|see (more|all)|read more|lire la suite|candidature spontanee|spontaneous application|decouvrir|details?|view (job|all jobs)|nos offres|toutes les offres|all jobs)\b/;

// Hôtes dont les offres se lisent par l'API publique (ats.ts) : inutile d'y lire les pages une à une.
const API_ATS = new Set(["greenhouse", "lever", "ashby", "smartrecruiters", "workable"]);

// ── Point d'entrée ────────────────────────────────────────────────────────────
function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
}

async function fetchHome(domain: string, deadline: number): Promise<Page> {
  const bare = domain.replace(/^www\./, "");
  // https d'abord ; http en dernier recours (vieux sites sans certificat valide)
  const attempts = domain.startsWith("www.")
    ? [`https://${domain}/`, `https://${bare}/`, `http://${domain}/`]
    : [`https://${bare}/`, `https://www.${bare}/`, `http://${bare}/`];
  let last: unknown = new Error("aucune tentative");
  for (const url of attempts) {
    try {
      const page = await fetchPage(url, deadline);
      if (page.status < 400 || isBlocked(page)) return page;
      last = new Error(`HTTP ${page.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * Cherche la page carrières d'un site, les ATS qu'il référence et ses offres en
 * JSON-LD. Une quinzaine de requêtes au plus par domaine (2 à 8 en général).
 */
export async function detectCareers(domain: string): Promise<CareersResult> {
  const result: CareersResult = { domain: cleanDomain(domain), careersUrl: null, atsUrls: [], postings: [], error: null, platform: null, jobLinks: [] };
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(result.domain)) return { ...result, error: "domaine invalide" };
  const deadline = Date.now() + DOMAIN_BUDGET;
  const ats = new Set<string>();
  const postings = new Map<string, Posting>();
  const addPostings = (list: Posting[]): number => {
    for (const p of list) if (!postings.has(p.external_id)) postings.set(p.external_id, p);
    return list.length;
  };

  try {
    const home = await fetchHome(result.domain, deadline);
    if (isBlocked(home)) throw new Error(`accès refusé (anti-robot, HTTP ${home.status})`);
    if (!home.html) throw new Error("page d'accueil vide ou non HTML");
    collectAtsUrls(home, ats);
    addPostings(parseJobPostings(home.html, home.url));

    // 1. page carrières : meilleurs liens de l'accueil, sinon chemins usuels
    let careers: Page | null = null;
    let candidates = careersCandidates(home);
    if (!candidates.length) {
      const about = aboutLink(home);
      if (about) {
        try {
          const page = await fetchPage(about, deadline);
          if (page.status < 400 && page.html) {
            collectAtsUrls(page, ats);
            candidates = careersCandidates(page).filter((u) => u !== page.url);
          }
        } catch {
          /* page « à propos » illisible : on passe aux chemins usuels */
        }
      }
    }
    for (const url of candidates.slice(0, 3)) {
      try {
        const page = await fetchPage(url, deadline);
        if (page.status < 400 && page.html) {
          careers = page;
          break;
        }
        // lien suivi jusqu'à un ATS qui refuse les robots : l'URL finale reste un signal
        if (atsNameOfUrl(page.url)) ats.add(page.url);
        else if (atsNameOfUrl(url)) ats.add(url);
      } catch {
        if (atsNameOfUrl(url)) ats.add(url);
      }
    }
    if (!careers && !candidates.length) {
      const origin = new URL(home.url).origin;
      let blocked = 0;
      for (const path of PROBE_PATHS.slice(0, MAX_PROBES)) {
        try {
          const page = await fetchPage(origin + path, deadline);
          if (looksLikeCareers(page, home)) {
            careers = page;
            break;
          }
          if (isBlocked(page) && ++blocked >= 2) break; // le site ne veut pas de nous : on n'insiste pas
        } catch {
          break; // site lent ou coupé : inutile d'enchaîner les sondages
        }
      }
    }

    // dernier recours : jobs.exemple.com / careers.exemple.com (souvent un ATS en marque blanche)
    if (!careers && !ats.size) {
      const root = registrable(new URL(home.url).hostname);
      for (const sub of ["jobs", "careers"]) {
        try {
          const page = await fetchPage(`https://${sub}.${root}/`, Math.min(deadline, Date.now() + 5000));
          // un DNS générique renvoie l'accueil ou une erreur : seule une vraie page compte
          const host = new URL(page.url).hostname;
          const ok = page.status < 400 && page.html !== "" && page.html.length !== home.html.length;
          if (ok && (host.startsWith(sub + ".") || atsNameOfUrl(page.url))) {
            careers = page;
            break;
          }
        } catch {
          /* sous-domaine inexistant */
        }
      }
    }

    if (careers) {
      result.careersUrl = careers.url;
      collectAtsUrls(careers, ats);
      const direct = addPostings(parseJobPostings(careers.html, careers.url));
      let extraLinks: Array<{ url: string; title: string }> = [];

      result.platform = platformOf(careers);

      // 2. liste complète des offres quand la page carrières n'en montre qu'un extrait
      //    (« /jobs », jobs.exemple.com), ou sas « voir nos offres » si rien n'a été trouvé
      let listing = careers;
      const hopUrl =
        indexLink(careers) ??
        (!ats.size && !direct && !jobLinks(careers).length
          ? (careersCandidates(careers).find((u) => u !== careers!.url && u !== candidates[0]) ?? null)
          : null);
      if (hopUrl && !(atsNameOfUrl(careers.url) && API_ATS.has(atsNameOfUrl(careers.url)!))) {
        try {
          const page = await fetchPage(hopUrl, deadline);
          if (page.status < 400 && page.html) {
            // les liens d'offre des deux pages sont lus ensemble
            listing = { url: page.url, status: page.status, html: page.html };
            extraLinks = jobLinksWithTitle(careers);
            collectAtsUrls(page, ats);
            addPostings(parseJobPostings(page.html, page.url));
            result.platform ??= platformOf(page);
          }
        } catch {
          /* on garde la première page */
        }
      }

      // 3. pages d'offre : lues tant qu'elles livrent du JSON-LD, abandon rapide sinon
      const hostAts = atsNameOfUrl(listing.url);
      if (!(hostAts && API_ATS.has(hostAts))) {
        const titled = [...jobLinksWithTitle(listing), ...extraLinks];
        // intitulés plausibles seulement : ni bouton (« Postuler »), ni lien de navigation
        const seenLinks = new Set<string>();
        for (const l of titled) {
          if (seenLinks.has(l.url) || l.title.length < 8 || l.title.length > 120 || GENERIC_LINK_TEXT.test(norm(l.title))) continue;
          seenLinks.add(l.url);
          if (result.jobLinks.length < 50) result.jobLinks.push(l);
        }
        const links = [...new Set(titled.map((l) => l.url))].slice(0, MAX_JOB_PAGES);
        let read = 0;
        let withLd = 0;
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < links.length) {
            if (read >= BLIND_JOB_PAGES && withLd === 0) return;
            const url = links[next++];
            try {
              const page = await fetchPage(url, deadline);
              read++;
              if (isBlocked(page)) return;
              collectAtsUrls(page, ats);
              if (addPostings(parseJobPostings(page.html, page.url))) withLd++;
            } catch {
              read++;
            }
          }
        };
        // la première page seule, pour ne pas lancer trois requêtes vers un site sans JSON-LD
        const first = Math.min(1, links.length);
        if (first) {
          const head = links.slice(0, BLIND_JOB_PAGES);
          for (const url of head) {
            next++;
            try {
              const page = await fetchPage(url, deadline);
              read++;
              if (isBlocked(page)) break;
              collectAtsUrls(page, ats);
              if (addPostings(parseJobPostings(page.html, page.url))) {
                withLd++;
                break;
              }
            } catch {
              read++;
            }
          }
          if (withLd) await Promise.all(Array.from({ length: JOB_PAGE_CONCURRENCY }, worker));
        }
      }
    }
  } catch (err) {
    result.error = errMsg(err);
  }

  result.atsUrls = [...ats];
  result.postings = [...postings.values()];
  return result;
}
