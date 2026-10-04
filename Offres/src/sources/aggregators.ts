/**
 * Agrégateurs d'offres : ils couvrent les annonces publiées sur les jobboards
 * plutôt que sur l'ATS de l'entreprise. Quatre sources :
 *  - Adzuna (app_id / app_key, gratuit, 250 appels / jour) ;
 *  - Arbeitnow (flux public sans clé du site français, surtout des offres reprises d'ATS).
 *  - DevITjobs (flux XML public du jobboard tech devitjobs.fr, un seul appel) ;
 *  - Free-Work (API du jobboard IT, sans clé mais non documentée : à activer
 *    explicitement par FREEWORK_ENABLED=1).
 *
 * Chaque source renvoie des `Posting` situés en France ; le tri tech reste fait
 * par classify.ts. Contrairement aux ATS, ces flux charrient beaucoup d'annonces
 * de cabinets et d'ESN : `looksLikeAgency` les signale, sans les écarter.
 */
import { type Posting } from "../ats.js";
import { isInFrance } from "../classify.js";

export interface AggregatorSource {
  key: string; // "adzuna" | "arbeitnow" | "devitjobs" | "freework"
  name: string;
  configured(): boolean; // utilisable tout de suite (clés présentes, ou aucune clé requise)
  /** Offres tech en France publiées depuis `days` jours (7 par défaut), en au plus `maxRequests` appels HTTP. */
  fetch(opts?: { days?: number; maxRequests?: number }): Promise<Posting[]>;
}

const TIMEOUT = 20000;
const DESCRIPTION_MAX = 8000;
const DAY = 86_400_000;

type Obj = Record<string, any>;

const env = (name: string): string => (process.env[name] ?? "").trim();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown): number | null => {
  const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};
const norm = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/** HTML ou texte → texte brut tronqué (même règle que ats.ts, dont le helper n'est pas exporté). */
function toText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = decodeEntities(
    html
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text ? text.slice(0, DESCRIPTION_MAX) : null;
}

/** Compteur d'appels HTTP partagé par une collecte : `maxRequests` est un plafond dur. */
class Budget {
  constructor(public left: number) {}
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
}

/** Source appelée sans ses clés. */
export class AggregatorNotConfigured extends Error {}

/**
 * Parcours « en largeur » de plusieurs recherches paginées : d'abord la première
 * page de chacune (les offres les plus récentes), puis les pages suivantes tant
 * qu'il reste du budget. Une recherche en erreur est abandonnée sans arrêter les
 * autres ; si TOUTES échouent, l'erreur remonte.
 */
async function sweep<Q>(
  queries: Q[],
  budget: Budget,
  page: (q: Q, index: number) => Promise<{ items: Posting[]; more: boolean }>
): Promise<Posting[]> {
  const seen = new Map<string, Posting>();
  let active = queries.map((q) => ({ q, index: 0 }));
  let ok = 0;
  let lastError: unknown = null;
  while (active.length && budget.left > 0) {
    const next: typeof active = [];
    for (const a of active) {
      if (budget.left <= 0) break;
      try {
        const { items, more } = await page(a.q, a.index);
        ok++;
        for (const p of items) if (p.external_id && p.title && p.url && !seen.has(p.external_id)) seen.set(p.external_id, p);
        if (more) next.push({ q: a.q, index: a.index + 1 });
      } catch (err) {
        if (err instanceof AggregatorNotConfigured) throw err;
        lastError = err;
      }
    }
    active = next;
  }
  if (!ok && lastError) throw lastError;
  return [...seen.values()];
}

// ───────────────────────────── Cabinets / ESN ─────────────────────────────

// Cabinets de recrutement, intérim et plateformes de freelances (nom de l'annonceur).
const AGENCY_NAMES =
  /\b(adecco|manpower|randstad|expectra|hays|michael page|page personnel|page ?group|robert half|robert walters|walters people|kelly services|synergie|groupe crit|crit interim|proman|start people|experis|fed it|fed group|lhh|lynx rh|aquila rh|temporis|partnaire|samsic emploi|gi group|menway|adsearch|approach people|externatic|silkhom|easy partner|urban linker|mobiskill|harry hope|opensourcing|seyos|kicklox|club freelance|mindquest|freelance\.com|computer futures|sthree|huxley|real staffing|progressive recruitment|hunteo|s&you|nexten|skillwise|altaide|ethic recrutement|jobs? ?&? ?talents?|talent\.io|free[- ]work|hellowork|jobgether|agent\.pro)\b/;

// ESN / sociétés de conseil qui placent les candidats chez leurs clients.
const ESN_NAMES =
  /\b(capgemini|sopra steria|atos|eviden|cgi|accenture|alten|altran|akkodis|modis|aubay|devoteam|inetum|gfi informatique|econocom|groupe open|neurones|sii|astek|extia|scalian|davidson|expleo|apside|ausy|consort|cs group|infotel|onepoint|talan|hardis|klanik|amaris|mantu|alteca|celad|davricourt|meritis|sqli|niji|hn services|it ?link|proxiad|viveris|technology (&|and) strategy|abylsen|ekkiden|agap2|segula|micropole|keyrus|business (&|and) decision|umanis|spie ics|zenika|xebia|publicis sapient|octo technology|ippon|sfeir|wemanity|cellenza|squad|lincoln|nextoo|open ?classrooms? consulting|groupe sii|elsys design|ntt data|tata consulting|tcs|cognizant|wipro|infosys|hcl ?tech\w*|dxc|sogeti|aneo|adentis|kaliop|blue soft|bluesoft|scient|synchrone|ad[- ]?missions|freelance republik|izyfreelance|cherry pick|malt)\b/;

// Mots génériques dans le nom de l'annonceur.
const AGENCY_WORDS =
  /\b(interim|recrutement|recruitment|recruiting|staffing|executive search|chasseurs? de tetes?|headhunt\w*|portage salarial|ressources humaines|rh|consulting|conseil|esn|ssii)\b/;

// Tournures typiques d'une annonce passée pour le compte d'un tiers.
const AGENCY_PHRASES =
  /\b(notre client|pour (l'un|un|une|le compte) de(s)? (nos|notre) clients?|pour le compte d[e'u]|chez (nos|notre|l'un de nos|un de nos) clients?|aupres de (nos|notre) clients?|client final|cabinet de (conseil en )?recrutement|cabinet de chasse|agence d'interim|travail temporaire|portage salarial|entreprise de services (du|numeriques)|societe de (conseil|services) (en|et) (ingenierie|technologies|informatique|numerique)|missions? (chez|aupres de|en clientele)|en regie|inter[- ]?contrat|our client|on behalf of (our|a) client|for (one of )?our clients?|recruitment (agency|firm)|staffing (agency|firm))\b/;

/** Pourquoi l'annonce ressemble à celle d'un cabinet / d'une ESN (null sinon). */
export function agencyReason(posting: Pick<Posting, "company" | "description">): string | null {
  const company = norm(posting.company ?? "");
  const byName = AGENCY_NAMES.exec(company) ?? ESN_NAMES.exec(company) ?? AGENCY_WORDS.exec(company);
  if (byName) return `annonceur : ${byName[0]}`;
  const phrase = AGENCY_PHRASES.exec(norm(posting.description ?? "").replace(/’/g, "'"));
  return phrase ? `texte : ${phrase[0]}` : null;
}

/**
 * Heuristique : l'annonce vient-elle d'un cabinet de recrutement, d'une agence
 * d'intérim ou d'une ESN (et non de l'entreprise qui embauche pour elle-même) ?
 * Sert à poser un drapeau, pas à supprimer l'offre.
 */
export function looksLikeAgency(posting: Pick<Posting, "company" | "description">): boolean {
  return agencyReason(posting) !== null;
}

// ───────────────────────────────── Adzuna ─────────────────────────────────

const ADZUNA_URL = "https://api.adzuna.com/v1/api/jobs/fr/search";
const ADZUNA_PAGE = 50; // maximum admis par results_per_page
// Quota gratuit : 25 appels / minute (250 / jour, 1000 / semaine, 2500 / mois).
const ADZUNA_PAUSE = 2500;

/**
 * La catégorie « it-jobs » est la base ; les mots-clés dans le titre rattrapent
 * les postes tech classés ailleurs (ingénierie, conseil…).
 */
const ADZUNA_QUERIES: Array<Record<string, string>> = [
  { category: "it-jobs" },
  { title_only: "développeur" },
  { title_only: "developer" },
  { title_only: "devops" },
  { title_only: "data" },
];

/** Annonce Adzuna → Posting (exporté pour les tests sur un exemple documenté). */
export function mapAdzuna(j: Obj): Posting {
  const area = ((j.location?.area ?? []) as unknown[]).filter((a): a is string => typeof a === "string");
  const title = toText(str(j.title)) ?? ""; // le titre peut contenir des <strong> de surlignage
  const description = toText(str(j.description)); // extrait de 500 caractères au plus
  return {
    external_id: String(j.id ?? ""),
    title,
    company: str(j.company?.display_name),
    department: str(j.category?.label),
    location: str(j.location?.display_name) ?? (area.length ? area.slice(1).reverse().join(", ") : null),
    country: "FR", // la recherche est faite sur l'index français
    remote: /\b(full remote|remote|t[ée]l[ée]travail complet|100 ?% t[ée]l[ée]travail)\b/i.test(title),
    url: String(j.redirect_url ?? ""), // lien de redirection, imposé par les conditions d'Adzuna
    description,
    posted_at: date(j.created),
  };
}

async function adzunaPage(
  query: Record<string, string>,
  index: number,
  days: number,
  budget: Budget,
  pace: boolean
): Promise<{ items: Posting[]; more: boolean }> {
  if (!budget.take()) return { items: [], more: false };
  if (pace) await sleep(ADZUNA_PAUSE);
  const url = `${ADZUNA_URL}/${index + 1}?${new URLSearchParams({
    app_id: env("ADZUNA_APP_ID"),
    app_key: env("ADZUNA_APP_KEY"),
    results_per_page: String(ADZUNA_PAGE),
    max_days_old: String(days),
    sort_by: "date",
    "content-type": "application/json",
    ...query,
  })}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT) });
  if (res.status === 401 || res.status === 410) throw new Error("Adzuna : clés refusées (ADZUNA_APP_ID / ADZUNA_APP_KEY)");
  if (res.status === 429) throw new Error("Adzuna : quota d'appels atteint");
  if (!res.ok) throw new Error(`Adzuna : HTTP ${res.status} (${JSON.stringify(query)})`);
  const data = (await res.json()) as Obj;
  const items = ((data.results ?? []) as Obj[]).map(mapAdzuna);
  const total = Number(data.count);
  const more = items.length === ADZUNA_PAGE && (Number.isFinite(total) ? (index + 1) * ADZUNA_PAGE < total : true);
  return { items, more };
}

const adzuna: AggregatorSource = {
  key: "adzuna",
  name: "Adzuna",
  configured: () => Boolean(env("ADZUNA_APP_ID") && env("ADZUNA_APP_KEY")),
  async fetch(opts = {}) {
    if (!this.configured()) throw new AggregatorNotConfigured("ADZUNA_APP_ID / ADZUNA_APP_KEY manquants");
    const days = Math.max(1, opts.days ?? 7);
    const max = opts.maxRequests ?? 20;
    const budget = new Budget(max);
    // au-delà de 20 appels, on s'étale pour rester sous 25 appels / minute
    return sweep(ADZUNA_QUERIES, budget, (q, i) => adzunaPage(q, i, days, budget, max > 20));
  },
};

// ──────────────────────────────── Arbeitnow ────────────────────────────────

// Le flux du site français (arbeitnow.fr) : 100 offres par page, triées par date,
// presque toutes en France. Celui d'arbeitnow.com est allemand, avec seulement
// quelques dizaines d'offres françaises mêlées aux deux premières pages.
const ARBEITNOW_URL = "https://www.arbeitnow.fr/api/job-board-api";

/** Annonce Arbeitnow → Posting (exporté pour les tests). */
export function mapArbeitnow(j: Obj): Posting {
  const tags = ((j.tags ?? []) as unknown[]).filter((t): t is string => typeof t === "string" && Boolean(t.trim()));
  const created = Number(j.created_at); // secondes Unix
  return {
    external_id: String(j.slug ?? ""),
    title: String(j.title ?? "").trim(),
    company: str(j.company_name),
    department: tags.length ? tags.join(", ") : null, // service ou métier tel que saisi dans l'ATS d'origine
    location: str(j.location),
    country: null, // non fourni : le lieu seul situe l'offre
    remote: j.remote === true,
    url: String(j.url ?? ""),
    description: toText(str(j.description)),
    posted_at: Number.isFinite(created) && created > 0 ? created * 1000 : null,
  };
}

const arbeitnow: AggregatorSource = {
  key: "arbeitnow",
  name: "Arbeitnow",
  configured: () => true, // flux public, sans clé
  async fetch(opts = {}) {
    const days = Math.max(1, opts.days ?? 7);
    const budget = new Budget(opts.maxRequests ?? 10);
    const cutoff = Date.now() - days * DAY;
    const seen = new Map<string, Posting>();
    // Ni filtre de pays ni filtre de date : on lit les pages (de la plus récente à la
    // plus ancienne) jusqu'à une page entièrement sortie de la fenêtre.
    for (let page = 1; budget.take(); page++) {
      const res = await fetch(`${ARBEITNOW_URL}?page=${page}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (res.status === 429) break; // 50 appels par fenêtre : on garde ce qui est déjà lu
      if (!res.ok) {
        if (seen.size) break;
        throw new Error(`Arbeitnow : HTTP ${res.status}`);
      }
      const data = (await res.json()) as Obj;
      const rows = ((data.data ?? []) as Obj[]).map(mapArbeitnow);
      let fresh = 0;
      for (const p of rows) {
        if (p.posted_at !== null && p.posted_at < cutoff) continue;
        fresh++;
        if (p.external_id && p.title && p.url && isInFrance(p.location, p.country) && !seen.has(p.external_id)) seen.set(p.external_id, p);
      }
      if (!rows.length || !fresh || !data.links?.next) break;
    }
    return [...seen.values()];
  },
};

// ─────────────────────────────── DevITjobs ───────────────────────────────

// Flux XML public du jobboard tech devitjobs.fr : toutes les offres actives (quelques
// centaines, toutes en France) en UN appel, avec entreprise et description. Ce
// sont surtout des annonces reprises de talent.com / Indeed / Adzuna.
const DEVITJOBS_URL = "https://devitjobs.fr/job_feed.xml";

/** Contenu d'une balise simple du flux (CDATA ou texte), null si absente ou vide. */
function xmlTag(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(block);
  return str(m?.[1] ?? m?.[2]);
}

/** Bloc <job> du flux DevITjobs → Posting (exporté pour les tests). */
export function mapDevItJobs(block: string): Posting {
  const url = xmlTag(block, "link") ?? xmlTag(block, "url") ?? "";
  // l'identifiant du flux porte un suffixe de semaine (« -W40 ») qui change chaque lundi
  const id = (xmlTag(block, "id") ?? "").replace(/-W\d+$/, "");
  const day = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(xmlTag(block, "pubdate") ?? ""); // « 04.10.2026 »
  const description = toText(xmlTag(block, "description"))?.replace(/\n?last updated \d+ week of \d+$/i, "").trim() ?? null;
  const title = xmlTag(block, "title") ?? xmlTag(block, "name") ?? "";
  return {
    external_id: id,
    title,
    company: xmlTag(block, "company"),
    department: block.match(/<job [^>]*category="([^"]+)"/)?.[1] ?? null, // toujours « IT »
    location: xmlTag(block, "location") ?? xmlTag(block, "city"),
    country: xmlTag(block, "country"),
    remote: /\b(full remote|100 ?% (en )?t[ée]l[ée]travail)\b/i.test(title),
    url,
    description: description || null,
    posted_at: day ? Date.UTC(Number(day[3]), Number(day[2]) - 1, Number(day[1])) : null,
  };
}

const devitjobs: AggregatorSource = {
  key: "devitjobs",
  name: "DevITjobs",
  configured: () => true, // flux public, sans clé
  async fetch(opts = {}) {
    const days = Math.max(1, opts.days ?? 7);
    if ((opts.maxRequests ?? 1) < 1) return [];
    const res = await fetch(DEVITJOBS_URL, { headers: { accept: "application/xml, text/xml" }, signal: AbortSignal.timeout(TIMEOUT * 2) });
    if (!res.ok) throw new Error(`DevITjobs : HTTP ${res.status}`);
    const xml = await res.text();
    // La date du flux est celle du dernier rafraîchissement de l'annonce (presque
    // toujours le jour même), pas celle de la première publication.
    const cutoff = Date.now() - (days + 1) * DAY;
    const seen = new Map<string, Posting>();
    for (const m of xml.matchAll(/<job [\s\S]*?<\/job>/g)) {
      const p = mapDevItJobs(m[0]);
      if (!p.external_id || !p.title || !p.url || seen.has(p.external_id)) continue;
      if (p.posted_at !== null && p.posted_at < cutoff) continue;
      if (isInFrance(p.location, p.country)) seen.set(p.external_id, p);
    }
    return [...seen.values()];
  },
};

// ─────────────────────────────── Free-Work ───────────────────────────────

// API (Hydra / API Platform) du jobboard IT free-work.com, lisible sans clé. Ce
// n'est PAS une API partenaire documentée : la source reste éteinte tant que
// FREEWORK_ENABLED=1 n'est pas posé, le temps de valider les conditions du site.
// Gros volume, mais annonces très majoritairement passées par des ESN / cabinets.
const FREEWORK_URL = "https://www.free-work.com/api/job_postings";
const FREEWORK_PAGE = 100; // au-delà, l'API répond 400 ; ~1 Mo par page
const FREEWORK_PAUSE = 1000;

/** Annonce Free-Work → Posting (exporté pour les tests). */
export function mapFreeWork(j: Obj): Posting {
  const loc = (j.location ?? {}) as Obj;
  const text = [j.description, j.candidateProfile, j.companyDescription].map((t) => toText(str(t))).filter(Boolean).join("\n\n");
  return {
    external_id: String(j.id ?? ""),
    title: String(j.title ?? "").trim(),
    company: str(j.company?.name),
    department: str(j.job?.name), // métier du référentiel Free-Work (« Développeur·euse fullstack »…)
    location: str(loc.label) ?? str(loc.locality),
    country: str(loc.countryCode) ?? str(loc.country),
    remote: j.remoteMode === "full",
    url: j.slug ? `https://www.free-work.com/fr/tech-it/job-mission/${j.job?.slug ?? "autre"}/${j.slug}` : "",
    description: text ? text.slice(0, DESCRIPTION_MAX) : null,
    // publishedAt est remis à jour quand l'annonce est republiée : la vraie
    // première publication est createdAt
    posted_at: date(j.createdAt) ?? date(j.publishedAt),
  };
}

const freework: AggregatorSource = {
  key: "freework",
  name: "Free-Work",
  configured: () => /^(1|true|yes|oui)$/i.test(env("FREEWORK_ENABLED")),
  async fetch(opts = {}) {
    if (!this.configured()) throw new AggregatorNotConfigured("FREEWORK_ENABLED=1 requis (API non documentée, à activer explicitement)");
    const days = Math.max(1, opts.days ?? 7);
    const budget = new Budget(opts.maxRequests ?? 5);
    const cutoff = Date.now() - days * DAY;
    const seen = new Map<string, Posting>();
    // Ordre par défaut : dernière (re)publication d'abord, à peu près. On s'arrête à
    // la première page dont plus aucune annonce n'a été (re)publiée dans la fenêtre.
    for (let page = 1; budget.take(); page++) {
      if (page > 1) await sleep(FREEWORK_PAUSE);
      const res = await fetch(`${FREEWORK_URL}?${new URLSearchParams({ page: String(page), itemsPerPage: String(FREEWORK_PAGE), contracts: "permanent" })}`, {
        headers: { accept: "application/ld+json" },
        signal: AbortSignal.timeout(TIMEOUT * 2),
      });
      if (!res.ok) {
        if (seen.size) break;
        throw new Error(`Free-Work : HTTP ${res.status}`);
      }
      const data = (await res.json()) as Obj;
      const rows = (data["hydra:member"] ?? []) as Obj[];
      let fresh = 0;
      for (const j of rows) {
        if ((date(j.publishedAt) ?? date(j.createdAt) ?? Date.now()) < cutoff) continue;
        fresh++;
        const p = mapFreeWork(j);
        // seules les annonces CRÉÉES dans la fenêtre comptent : les autres sont des remontées
        if (p.posted_at !== null && p.posted_at < cutoff) continue;
        if (p.external_id && p.title && p.url && isInFrance(p.location, p.country) && !seen.has(p.external_id)) seen.set(p.external_id, p);
      }
      if (!rows.length || !fresh || !data["hydra:view"]?.["hydra:next"]) break;
    }
    return [...seen.values()];
  },
};

export const AGGREGATORS: AggregatorSource[] = [adzuna, arbeitnow, devitjobs, freework];
