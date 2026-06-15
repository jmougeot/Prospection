/**
 * Enrichissement d'une entreprise par son NOM, via l'API publique « Recherche
 * d'Entreprises » (recherche-entreprises.api.gouv.fr — gratuite, sans clé,
 * France uniquement). Sert à filtrer les prospects par taille / secteur / CA :
 * le nom de boîte lu dans un résultat LinkedIn n'a pas ces attributs, on va les
 * chercher dans le registre. Le rapprochement nom → entreprise est « best
 * effort » (on prend le meilleur résultat de l'API). Résultats mis en cache
 * (table company_cache) : une même entreprise n'est jamais requêtée deux fois.
 */
import { db } from "../../db.js";

const API_URL = "https://recherche-entreprises.api.gouv.fr/search";

/** Tranches d'effectifs INSEE → libellés (partagé avec l'UI via /api/b2b/meta). */
export const EFFECTIF_LABELS: Record<string, string> = {
  NN: "non renseigné",
  "00": "0 salarié",
  "01": "1-2",
  "02": "3-5",
  "03": "6-9",
  "11": "10-19",
  "12": "20-49",
  "21": "50-99",
  "22": "100-199",
  "31": "200-249",
  "32": "250-499",
  "41": "500-999",
  "42": "1000-1999",
  "51": "2000-4999",
  "52": "5000-9999",
  "53": "10000+",
};

export const SECTION_LABELS: Record<string, string> = {
  A: "Agriculture, sylviculture et pêche",
  B: "Industries extractives",
  C: "Industrie manufacturière",
  D: "Électricité, gaz, vapeur",
  E: "Eau, assainissement, déchets",
  F: "Construction",
  G: "Commerce, réparation auto",
  H: "Transports et entreposage",
  I: "Hébergement et restauration",
  J: "Information et communication",
  K: "Activités financières et d'assurance",
  L: "Activités immobilières",
  M: "Activités spécialisées, scientifiques et techniques",
  N: "Services administratifs et de soutien",
  O: "Administration publique",
  P: "Enseignement",
  Q: "Santé humaine et action sociale",
  R: "Arts, spectacles et activités récréatives",
  S: "Autres activités de services",
  T: "Ménages employeurs",
  U: "Activités extra-territoriales",
};

export interface CompanyInfo {
  siren: string | null;
  effectif: string | null; // code INSEE de tranche (clé de EFFECTIF_LABELS)
  naf_section: string | null; // section A..U
  ca: number | null; // dernier chiffre d'affaires connu (€)
}

// Throttle simple : l'API autorise 7 req/s, on reste sous 5/s.
let lastCall = 0;
async function throttle(): Promise<void> {
  const wait = lastCall + 220 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

const cacheGet = db.prepare("SELECT info FROM company_cache WHERE name_key = ?");
const cachePut = db.prepare("INSERT OR REPLACE INTO company_cache (name_key, info, fetched_at) VALUES (?, ?, ?)");

// Index d'alias (résolveur de noms) — table company_alias (voir db.ts).
const aliasExact = db.prepare(
  // alias ambigu (plusieurs SIREN) : on préfère la ligne qui PORTE des données
  "SELECT siren, effectif, naf_section, ca FROM company_alias WHERE alias_norm = ? " +
    "ORDER BY (effectif IS NOT NULL OR ca IS NOT NULL) DESC LIMIT 1"
);
const aliasLike = db.prepare(
  "SELECT alias_norm, siren, effectif, naf_section, ca FROM company_alias WHERE alias_norm LIKE ? LIMIT 200"
);
const aliasPut = db.prepare(
  "INSERT OR IGNORE INTO company_alias (alias_norm, siren, effectif, naf_section, ca, source) VALUES (?, ?, ?, ?, ?, ?)"
);
const aliasBackfill = db.prepare(
  "UPDATE company_alias SET effectif = ?, naf_section = ?, ca = ? WHERE siren = ? AND effectif IS NULL AND ca IS NULL"
);

/**
 * Tokens d'un nom : sans accents, sans forme juridique, sans articles ni
 * ponctuation. Retirer les articles (de, du, la, l'…) canonicalise mieux les
 * variantes (« Direction générale DES finances » ≡ « Direction générale
 * finances », « L'Oréal » → « oreal ») pour que l'index d'alias matche en exact.
 */
function nameTokens(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(sas|sasu|sarl|eurl|sa|sci|group|groupe|holding|france|de|du|des|la|le|les|l|d|et|en|au|aux)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Clé de cache/recherche/résolution d'un nom venu de LinkedIn : on retire
 * d'abord les parenthèses (taglines, domaines — « Alan (alan.com) » → « Alan »)
 * qui polluent la requête au registre. Exportée pour que le script de seed
 * d'alias normalise EXACTEMENT comme la résolution (clés cohérentes).
 */
export function nameKey(name: string): string {
  return nameTokens(name.replace(/\([^)]*\)/g, " "));
}

/**
 * Choisit, parmi les résultats de l'API, celui qui correspond le mieux au nom
 * cherché — ou null si aucun ne s'en approche. Rapprochement volontairement
 * souple (les noms LinkedIn diffèrent souvent de la raison sociale) : il suffit
 * que la moitié des mots du nom se retrouve dans les noms du candidat —
 * raison sociale, sigle, noms commerciaux et enseignes des établissements
 * (« BlaBlaCar » est l'enseigne de COMUTO, « BACK MARKET » le nom commercial
 * de JUNG S.A.S). À couverture égale, on préfère un candidat qui A des données
 * (effectif/CA) — c'est sur elles qu'on filtre et ça départage les homonymes —
 * puis le moins de mots en trop (« ALAN » exact bat « ALAN PUREN »).
 */
interface MatchingEtab {
  nom_commercial?: string | null;
  liste_enseignes?: string[] | null;
}
function bestMatch(key: string, results: Array<Record<string, unknown>>): Record<string, unknown> | null {
  const wanted = key.split(" ");
  let best: Record<string, unknown> | null = null;
  let bestScore = -1;
  for (const r of results) {
    const etabs = (r.matching_etablissements as MatchingEtab[] | undefined) ?? [];
    const names = [
      r.nom_complet,
      r.sigle,
      ...etabs.flatMap((e) => [e.nom_commercial, ...(e.liste_enseignes ?? [])]),
    ].filter(Boolean);
    // tokens uniques : les enseignes répètent le nom (« DOCTOLIB » × N établissements),
    // compter les occurrences pénaliserait à tort les entreprises multi-sites
    const candSet = new Set(nameTokens(names.join(" ")).split(" "));
    const coverage = wanted.filter((w) => candSet.has(w)).length / wanted.length;
    if (coverage < 0.5) continue;
    const effectif = r.tranche_effectif_salarie as string | null;
    const hasData = (effectif && effectif !== "NN") || latestCa(r.finances) !== null;
    const score = coverage + (hasData ? 0.25 : 0) - 0.01 * Math.max(0, candSet.size - wanted.length);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Dernier chiffre d'affaires connu dans le bloc `finances` de l'API. */
function latestCa(finances: unknown): number | null {
  if (!finances || typeof finances !== "object") return null;
  const years = Object.keys(finances as Record<string, unknown>).sort().reverse();
  for (const y of years) {
    const f = (finances as Record<string, { ca?: number | null }>)[y];
    if (f && typeof f.ca === "number") return f.ca;
  }
  return null;
}

/**
 * Sème l'index d'alias depuis un enregistrement de l'API : toutes les formes de
 * nom (raison sociale, sigle, noms commerciaux, enseignes) → la même entité.
 * Une boîte résolue une fois est ensuite reconnue par n'importe lequel de ses
 * noms d'usage, sans re-appel réseau.
 */
function seedFromRecord(r: Record<string, unknown>, info: CompanyInfo, source: string): void {
  const etabs = (r.matching_etablissements as MatchingEtab[] | undefined) ?? [];
  const names = [
    r.nom_complet,
    r.nom_raison_sociale,
    r.sigle,
    ...etabs.flatMap((e) => [e.nom_commercial, ...(e.liste_enseignes ?? [])]),
  ]
    .filter(Boolean)
    .map(String);
  for (const n of names) {
    const k = nameKey(n);
    if (k) aliasPut.run(k, info.siren, info.effectif, info.naf_section, info.ca, source);
  }
}

/**
 * Renvoie les attributs registre d'une entreprise à partir de son nom, ou null
 * si introuvable. Mis en cache (succès comme échec) pour ne jamais re-requêter.
 * Dernier recours de resolveCompany : best-effort par nom (peut mal apparier).
 */
export async function enrichCompanyByName(name: string, retried = false): Promise<CompanyInfo | null> {
  const key = nameKey(name);
  if (!key) return null;
  const cached = cacheGet.get(key) as { info: string } | undefined;
  if (cached) return JSON.parse(cached.info) as CompanyInfo | null;

  let info: CompanyInfo | null = null;
  try {
    await throttle();
    const params = new URLSearchParams({ q: key, page: "1", per_page: "5", etat_administratif: "A" });
    const res = await fetch(`${API_URL}?${params}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429 && !retried) {
      await new Promise((r) => setTimeout(r, 1500));
      return enrichCompanyByName(name, true); // une seule relance après backoff
    }
    if (res.ok) {
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const r = bestMatch(key, data.results ?? []);
      if (r) {
        info = {
          siren: r.siren ? String(r.siren) : null,
          effectif: (r.tranche_effectif_salarie as string) ?? null,
          naf_section: (r.section_activite_principale as string) ?? null,
          ca: latestCa(r.finances),
        };
        seedFromRecord(r, info, "api"); // reconnaître la boîte par tous ses noms ensuite
      }
    }
  } catch {
    // réseau/timeout : on met en cache un échec pour ne pas boucler dessus
    info = null;
  }
  cachePut.run(key, JSON.stringify(info), Date.now());
  return info;
}

/**
 * Attributs registre d'une entreprise par son SIREN (lookup exact, sans
 * ambiguïté de nom). Sert à compléter une entité résolue via un alias seedé sans
 * attributs (Wikidata : on a le SIREN, pas l'effectif). Mis en cache par SIREN.
 */
async function infoBySiren(siren: string): Promise<CompanyInfo | null> {
  const cacheKey = `siren:${siren}`;
  const cached = cacheGet.get(cacheKey) as { info: string } | undefined;
  if (cached) return JSON.parse(cached.info) as CompanyInfo | null;
  let info: CompanyInfo | null = null;
  try {
    await throttle();
    const params = new URLSearchParams({ q: siren, page: "1", per_page: "1" });
    const res = await fetch(`${API_URL}?${params}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const results = data.results ?? [];
      const r = results.find((x) => String(x.siren) === siren) ?? results[0];
      if (r) {
        info = {
          siren,
          effectif: (r.tranche_effectif_salarie as string) ?? null,
          naf_section: (r.section_activite_principale as string) ?? null,
          ca: latestCa(r.finances),
        };
        seedFromRecord(r, info, "api");
      }
    }
  } catch {
    info = null;
  }
  cachePut.run(cacheKey, JSON.stringify(info), Date.now());
  return info;
}

interface AliasRow {
  alias_norm?: string;
  siren: string | null;
  effectif: string | null;
  naf_section: string | null;
  ca: number | null;
}

const aliasToInfo = (r: AliasRow): CompanyInfo => ({
  siren: r.siren,
  effectif: r.effectif,
  naf_section: r.naf_section,
  ca: r.ca,
});

/**
 * Si l'entité résolue n'a pas d'attributs (alias seedé sans effectif/secteur),
 * on les complète par SIREN — lookup exact, fiable — et on backfill l'index.
 */
async function completeBySiren(info: CompanyInfo): Promise<CompanyInfo> {
  if (info.siren && info.effectif === null && info.ca === null) {
    const full = await infoBySiren(info.siren);
    if (full) {
      aliasBackfill.run(full.effectif, full.naf_section, full.ca, info.siren);
      return full;
    }
  }
  return info;
}

/**
 * Résolution floue (token-set) quand l'exact échoue : parmi les alias partageant
 * le token le plus distinctif du nom, on garde celui dont l'ensemble de tokens
 * recouvre le mieux (Jaccard ≥ 0,6). Rattrape les variantes d'ordre/de mots.
 */
function fuzzyAlias(key: string): AliasRow | null {
  const wanted = key.split(" ").filter(Boolean);
  if (!wanted.length) return null;
  const pivot = [...wanted].sort((a, b) => b.length - a.length)[0];
  if (pivot.length < 4) return null; // pivot trop court → trop de candidats/bruit
  const wantSet = new Set(wanted);
  let best: AliasRow | null = null;
  let bestScore = 0;
  for (const r of aliasLike.all(`%${pivot}%`) as AliasRow[]) {
    const cand = (r.alias_norm ?? "").split(" ").filter(Boolean);
    if (!cand.length) continue;
    const inter = cand.filter((w) => wantSet.has(w)).length;
    const score = inter / Math.max(wantSet.size, cand.length);
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 0.6 ? best : null;
}

/**
 * Résout un nom d'entreprise (tel que lu sur LinkedIn) en entité canonique +
 * attributs, SANS jointure par chaîne fragile : (1) hit exact dans l'index
 * d'alias — instantané ; (2) sinon fuzzy token-set sur l'index ; (3) en dernier
 * recours seulement, l'API registre best-effort (qui sème l'index au passage).
 * Remplace l'usage direct d'enrichCompanyByName côté filtrage.
 */
export async function resolveCompany(name: string): Promise<CompanyInfo | null> {
  const key = nameKey(name);
  if (!key) return null;
  const exact = aliasExact.get(key) as AliasRow | undefined;
  if (exact) return completeBySiren(aliasToInfo(exact));
  const fuzzy = fuzzyAlias(key);
  if (fuzzy) return completeBySiren(aliasToInfo(fuzzy));
  return enrichCompanyByName(name);
}

export interface CompanyFilters {
  effectifs?: Set<string>; // codes de tranche acceptés (vide = pas de filtre taille)
  sections?: Set<string>; // sections NAF acceptées (vide = pas de filtre secteur)
  caMin?: number; // CA minimum (€)
}

export function hasCompanyFilters(f: CompanyFilters): boolean {
  return Boolean((f.effectifs && f.effectifs.size) || (f.sections && f.sections.size) || f.caMin);
}

/** L'entreprise (déjà enrichie) passe-t-elle les filtres taille/secteur/CA ? */
export function companyPasses(info: CompanyInfo | null, f: CompanyFilters): boolean {
  if (!info) return false; // filtre actif mais entreprise non résolue → écartée
  if (f.effectifs && f.effectifs.size && !(info.effectif && f.effectifs.has(info.effectif))) return false;
  if (f.sections && f.sections.size && !(info.naf_section && f.sections.has(info.naf_section))) return false;
  if (f.caMin && !(info.ca !== null && info.ca >= f.caMin)) return false;
  return true;
}

// --- Énumération du registre (mode « ciblage par entreprises ») ----------------

/** Une entreprise listée depuis le registre, prête à être ciblée sur LinkedIn. */
export interface RegistryCompany {
  name: string; // nom à mettre dans la requête (alias commercial si disponible)
  info: CompanyInfo;
}

export interface RegistryPage {
  companies: RegistryCompany[];
  nextPage: number | null; // page registre suivante, null = registre épuisé
}

/**
 * Nom d'entreprise tel qu'on le met dans une requête LinkedIn : on préfère un
 * alias entre parenthèses quand il est substantiel (« JUNG S.A.S (BACK MARKET) »
 * → « BACK MARKET », c'est le nom utilisé sur LinkedIn), sinon le nom légal
 * débarrassé des formes juridiques (« ZAYO INFRASTRUCTURE FRANCE S.A. » →
 * « ZAYO INFRASTRUCTURE FRANCE »).
 */
function queryName(nomComplet: string): string {
  const aliases = [...nomComplet.matchAll(/\(([^)]+)\)/g)].map((m) => m[1].trim());
  const alias = aliases.find((a) => a.replace(/[^a-zA-Z]/g, "").length >= 4);
  const cleaned = (alias ?? nomComplet.replace(/\([^)]*\)/g, " "))
    .replace(/[.,]/g, " ")
    .replace(/\b(S A S U|S A R L|S A S|S A|SASU|SARL|EURL|SAS|SCI|SA)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || nomComplet;
}

/**
 * Liste les entreprises du registre correspondant aux filtres (taille, secteur,
 * CA min), à partir de la page `fromPage` (1-based), jusqu'à `max` entreprises
 * environ (arrondi à la page de 25). Chaque entreprise listée est semée dans
 * company_cache — sous son nom légal et ses alias — pour que le filtrage des
 * prospects la retrouve ensuite sans appel réseau.
 */
export async function listCompanies(f: CompanyFilters, max: number, fromPage = 1): Promise<RegistryPage> {
  const base = new URLSearchParams({ etat_administratif: "A", per_page: "25" });
  if (f.effectifs?.size) base.set("tranche_effectif_salarie", [...f.effectifs].join(","));
  if (f.sections?.size) base.set("section_activite_principale", [...f.sections].join(","));
  if (f.caMin) base.set("ca_min", String(f.caMin));
  const companies: RegistryCompany[] = [];
  let page = fromPage;
  let retries = 0;
  while (companies.length < max) {
    await throttle();
    base.set("page", String(page));
    const res = await fetch(`${API_URL}?${base}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 429 && retries < 3) {
      retries++;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    if (!res.ok) return { companies, nextPage: null };
    const data = (await res.json()) as { results?: Array<Record<string, unknown>>; total_pages?: number };
    for (const r of data.results ?? []) {
      const nom = r.nom_complet ? String(r.nom_complet) : "";
      if (!nom) continue;
      const info: CompanyInfo = {
        siren: r.siren ? String(r.siren) : null,
        effectif: (r.tranche_effectif_salarie as string) ?? null,
        naf_section: (r.section_activite_principale as string) ?? null,
        ca: latestCa(r.finances),
      };
      const keys = [nameKey(nom), ...[...nom.matchAll(/\(([^)]+)\)/g)].map((m) => nameTokens(m[1]))];
      for (const key of new Set(keys)) {
        if (key && !cacheGet.get(key)) cachePut.run(key, JSON.stringify(info), Date.now());
      }
      companies.push({ name: queryName(nom), info });
    }
    if (page >= (data.total_pages ?? page)) return { companies, nextPage: null };
    page++;
  }
  return { companies, nextPage: page };
}
