/**
 * Recherche directe de personnes par poste sur LinkedIn, via une API de recherche
 * (Google CSE / Serper / Brave) : une requête `site:linkedin.com/in "<poste>"
 * "<entreprise>"` renvoie ~10 profils par page, presque tous au bon poste. Chaque
 * résultat (titre + snippet) est interprété en personne par le modèle d'extraction
 * (extract.ts, Haiku) — nom, poste, entreprise, lieu. Le slug du profil doit
 * correspondre au nom (anti-bruit) ; le filtrage strict du poste se fait côté job.
 */
import { deaccent, normName as norm, titleCase } from "./domain.js";
import { apiSearch, hasSearchApi, type Region, type WebResult } from "./search.js";
import { extractPeople, hasExtractor } from "./extract.js";

// URL de profil LinkedIn (sous-domaine pays optionnel). Sans /g : exec() renvoie
// la première occurrence, sans état lastIndex partagé.
const PROFILE_ONE = /https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[a-zA-Z0-9%_.\-]+/;

// --- Postes : équivalences strictes et correspondance ------------------------

// Racine grossière d'un mot de poste : sans pluriel, tronquée — « directeur »
// matche « directrice »/« director », « commercial » matche « commerciale »
const stem = (w: string) => w.replace(/s$/, "").slice(0, 6);

/**
 * Le poste affiché correspond-il à l'un des termes demandés ? Tous les mots du
 * terme (racines) doivent apparaître dans le poste : « account executive »
 * matche « Senior Account Executive » mais pas « Directeur Commercial ».
 * Un poste inconnu (null) ne matche jamais : précision avant rappel.
 */
export function roleMatches(role: string | null, terms: string[]): boolean {
  if (!role) return false;
  const r = norm(role);
  return terms.some((t) => {
    const words = deaccent(t.toLowerCase()).split(/[^a-z]+/).filter((w) => w.length >= 2);
    return words.length > 0 && words.every((w) => r.includes(stem(w)));
  });
}

// Équivalences exactes d'un poste précis : mêmes responsabilités sous un autre
// nom (FR/EN, abréviations, féminin quand la racine diffère). Sert quand
// l'utilisateur tape un poste précis — on ne l'élargit PAS à toute la fonction.
const ROLE_EQUIV: Record<string, string[]> = {
  accountexecutive: ["account exec"],
  accountmanager: ["account management"],
  sdr: ["sales development representative", "business development representative", "bdr"],
  bdr: ["business development representative", "sales development representative", "sdr"],
  businessdeveloper: ["business development", "biz dev", "bizdev"],
  directeurcommercial: ["directrice commerciale", "head of sales", "sales director", "vp sales", "chief sales officer"],
  directeurmarketing: ["directrice marketing", "head of marketing", "marketing director", "cmo", "vp marketing"],
  directeurgeneral: ["directrice générale", "general manager", "managing director", "ceo"],
  directeurfinancier: ["directrice financière", "cfo", "daf", "head of finance", "finance director"],
  daf: ["directeur financier", "directrice financière", "cfo", "head of finance"],
  drh: ["directeur des ressources humaines", "directrice des ressources humaines", "head of hr", "hr director", "chro"],
  ceo: ["chief executive officer", "directeur général", "fondateur", "founder", "président"],
  cmo: ["chief marketing officer", "directeur marketing", "head of marketing"],
  cfo: ["chief financial officer", "directeur financier", "daf"],
  coo: ["chief operating officer", "directeur des opérations"],
  cto: ["chief technology officer", "directeur technique", "vp engineering"],
};

// Synonymes par grande fonction (FR + EN) : une recherche « commercial » doit
// aussi remonter les « Sales », « Business Developer », etc. Utilisé seulement
// pour un mot-clé générique d'un seul mot — un poste précis n'est pas élargi.
const ROLE_SYNONYMS: Array<{ match: RegExp; terms: string[] }> = [
  {
    match: /commercial|\bsales\b|vente|business dev|account/i,
    terms: ["commercial", "sales", "ventes", "business developer", "account executive", "account manager"],
  },
  {
    match: /marketing|growth|acquisition|communication/i,
    terms: ["marketing", "growth", "communication", "acquisition"],
  },
  {
    match: /\brh\b|ressources humaines|recrut|talent|\bhr\b/i,
    terms: ["RH", "ressources humaines", "recrutement", "talent acquisition", "recruteur"],
  },
  {
    match: /\bcto\b|\btech\b|technique|développeur|developer|ing[ée]nieur|engineer/i,
    terms: ["CTO", "directeur technique", "développeur", "software engineer", "lead tech"],
  },
  {
    match: /fondateur|founder|\bceo\b|pr[ée]sident|directeur g[ée]n[ée]ral|\bdg\b|dirigeant/i,
    terms: ["CEO", "fondateur", "founder", "président", "directeur général"],
  },
  {
    match: /finance|\bdaf\b|\bcfo\b|comptab/i,
    terms: ["CFO", "DAF", "directeur financier", "finance"],
  },
  {
    match: /achat|procurement|sourcing/i,
    terms: ["achats", "acheteur", "procurement"],
  },
  {
    match: /produit\b|product|\bcpo\b/i,
    terms: ["product manager", "produit", "head of product"],
  },
  {
    match: /op[ée]rations|\bcoo\b|\bops\b/i,
    terms: ["COO", "directeur des opérations", "operations"],
  },
];

/**
 * Termes cherchés (et acceptés au filtrage) pour un mot-clé de poste, le
 * mot-clé exact toujours en premier :
 * - poste précis connu (« account executive », « directeur commercial ») :
 *   ses équivalents stricts seulement ;
 * - mot générique d'un seul mot (« commercial », « marketing ») : son groupe
 *   de fonction élargi ;
 * - sinon : le mot-clé tel quel.
 */
export function roleTerms(keyword: string): string[] {
  const kw = keyword.trim();
  const equiv = ROLE_EQUIV[norm(kw)];
  if (equiv) return [kw, ...equiv.filter((t) => norm(t) !== norm(kw))];
  if (!/\s/.test(kw)) {
    const group = ROLE_SYNONYMS.find((g) => g.match.test(kw));
    if (group) return [kw, ...group.terms.filter((t) => norm(t) !== norm(kw))];
  }
  return [kw];
}

// --- Personne ----------------------------------------------------------------

export interface Prospect {
  first_name: string;
  last_name: string;
  role: string | null; // poste lu dans le résultat
  company: string | null; // entreprise lue dans le résultat
  company_domain: string | null; // domaine probable de l'entreprise (modèle, non vérifié)
  headcount_est: string | null; // effectif mondial estimé, ordre de grandeur (modèle, indicatif)
  revenue_est: string | null; // CA annuel estimé, ordre de grandeur (modèle, indicatif)
  location: string | null; // localisation lue dans le résultat
  linkedin: string; // URL du profil
}

/**
 * Le slug du profil (…/in/<slug>) reflète-t-il le nom ? Garde-fou anti-bruit /
 * anti-hallucination : un résultat dont l'URL ne reflète pas le nom extrait n'est
 * pas la bonne personne (pages diverses, homonymes, nom inventé par le modèle).
 */
export function slugMatchesName(url: string, first: string, last: string): boolean {
  let slug = url.split("/in/")[1] ?? "";
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* garde brut */
  }
  const slugNorm = norm(slug);
  return slugNorm.includes(norm(last).slice(0, 6)) || slugNorm.includes(norm(first));
}

// --- Requêtes et collecte -----------------------------------------------------

export interface PeopleSearchParams {
  roles: string[]; // postes recherchés (texte libre, au moins un)
  companies?: string[]; // boîtes cibles (liste fournie + sélection base enrichie)
  exclude?: string[]; // mots-clés à bannir du titre/de l'entreprise (ex. "senior")
  location?: string; // villes/régions, séparées par des virgules (optionnel)
  sector?: string; // mots-clés libres ajoutés à la requête (optionnel)
  region?: Region; // zone ciblée : biais moteur + sous-domaine LinkedIn (défaut « fr »)
}

/** Localisations demandées, découpées (« Paris, Lyon » → ["Paris", "Lyon"]). */
export function locationList(location?: string): string[] {
  return (location ?? "").split(/[,;/]+/).map((s) => s.trim()).filter(Boolean);
}

/** Tous les termes acceptés au filtrage pour une liste de postes (union, dédupliquée). */
export function allRoleTerms(roles: string[]): string[] {
  return [...new Set(roles.flatMap((r) => roleTerms(r)))];
}

/** Le texte contient-il un mot-clé exclu ? (comparaison sans accents/casse) */
export function isExcluded(text: string | null, exclude: string[]): boolean {
  if (!text || !exclude.length) return false;
  const t = deaccent(text.toLowerCase());
  return exclude.some((e) => {
    const w = deaccent(e.toLowerCase()).trim();
    return w.length > 0 && t.includes(w);
  });
}

/**
 * Requête ciblée sur UNE entreprise : les postes — tous synonymes confondus,
 * 4 max, en OR — doivent apparaître avec le nom de la boîte. Chaque entreprise
 * ouvre son propre espace de résultats. Localisation/secteur sont omis de la
 * requête (déjà étroite) et réappliqués au filtrage.
 */
export function companyQueries(params: PeopleSearchParams, companyName: string): string[] {
  // FR : les membres en France ont un profil fr.linkedin.com — on l'attaque en
  // premier, avec repli sur le domaine générique. US / international : pas de
  // sous-domaine dédié (les profils US vivent sur www.linkedin.com) → domaine
  // générique seul, le ciblage venant du biais pays du moteur (gl/hl).
  const sites =
    (params.region ?? "fr") === "fr"
      ? ["site:fr.linkedin.com/in", "site:linkedin.com/in"]
      : ["site:linkedin.com/in"];
  const terms = allRoleTerms(params.roles).slice(0, 4);
  const block = terms.length > 1 ? `(${terms.map((t) => `"${t}"`).join(" OR ")})` : `"${terms[0] ?? ""}"`;
  const neg = (params.exclude ?? []).map((e) => `-"${e}"`).join(" ");
  return sites.map((site) => `${site} ${block} "${companyName}"${neg ? ` ${neg}` : ""}`.replace(/\s+/g, " ").trim());
}

/**
 * Extraction LLM d'un lot de résultats. Chaque profil est identifié par son URL
 * (clé stable que le modèle ré-échoue — on remappe par elle, jamais par l'ordre)
 * et dédoublonné, en gardant le snippet le plus riche. Le slug du profil doit
 * refléter le nom extrait (anti-bruit / anti-hallucination).
 */
export async function extractProspects(results: WebResult[]): Promise<Prospect[]> {
  const byId = new Map<string, { id: string; text: string }>();
  for (const r of results) {
    const m = PROFILE_ONE.exec(r.url) ?? PROFILE_ONE.exec(`${r.title} ${r.snippet}`);
    if (!m) continue;
    const url = m[0].replace(/\/+$/, "");
    const text = `${r.title}\n${r.snippet}`.trim();
    const prev = byId.get(url);
    if (!prev || text.length > prev.text.length) byId.set(url, { id: url, text });
  }
  if (!byId.size) return [];
  const people = await extractPeople([...byId.values()]);
  const out: Prospect[] = [];
  for (const url of byId.keys()) {
    const e = people.get(url);
    if (!e) continue;
    const first = titleCase(e.first_name);
    const last = titleCase(e.last_name);
    if (!first || !last || /[\d@©]/.test(`${first}${last}`)) continue;
    if (!slugMatchesName(url, first, last)) continue;
    out.push({
      first_name: first,
      last_name: last,
      role: e.role,
      company: e.company,
      company_domain: e.company_domain,
      headcount_est: e.headcount_est,
      revenue_est: e.revenue_est,
      location: e.location,
      linkedin: url,
    });
  }
  return out;
}

/**
 * Entreprise inconnue : tentative d'enrichissement par une re-requête nominative
 * (« "Prénom Nom" site:linkedin.com/in ») dont on ré-extrait le snippet du bon
 * profil (apparié par slug). Best-effort, borné à UNE page (mise en cache). Ne
 * devine jamais : si rien, l'entreprise reste vide.
 */
export async function fillMissingCompany(p: Prospect): Promise<void> {
  if (p.company || !hasExtractor() || !hasSearchApi()) return;
  const results = await apiSearch(`site:linkedin.com/in "${p.first_name} ${p.last_name}"`, 0);
  if (!results?.length) return;
  const key = (u: string) => (u.split("/in/")[1] ?? "").toLowerCase().replace(/\/+$/, "");
  const target = key(p.linkedin);
  const match = results.find((r) => key(r.url) === target);
  if (!match) return;
  const people = await extractPeople([{ id: p.linkedin, text: `${match.title}\n${match.snippet}`.trim() }]);
  const e = people.get(p.linkedin);
  if (e?.company) p.company = e.company;
  if (e?.company_domain && !p.company_domain) p.company_domain = e.company_domain;
  if (e?.headcount_est && !p.headcount_est) p.headcount_est = e.headcount_est;
  if (e?.revenue_est && !p.revenue_est) p.revenue_est = e.revenue_est;
  if (!p.location && e?.location) p.location = e.location;
}

/**
 * Une page de résultats d'une requête via l'API de recherche, interprétée en
 * personnes (extraction LLM). Renvoie null si aucune API n'est configurée/
 * disponible. `raw` permet de détecter une requête épuisée (< 10 résultats bruts).
 */
export async function fetchProspectsPage(
  query: string,
  page: number,
  region: Region = "fr"
): Promise<{ prospects: Prospect[]; raw: number } | null> {
  const results = await apiSearch(query, page, region);
  if (results === null) return null;
  return { prospects: await extractProspects(results), raw: results.length };
}
