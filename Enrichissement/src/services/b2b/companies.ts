/**
 * Base d'entreprises (table `companies`) : noms enrichis depuis un export CSV
 * LinkedIn (domaine, effectif déclaré, secteur, localisation…). C'est la source
 * des entreprises cibles pour la prospection. Dédoublonnage sur le nom normalisé.
 * Aucun appel réseau ici : l'alimentation se fait par seed CSV (seed-companies.ts)
 * et au fil des recherches (recordCompany).
 */
import { db } from "../../db.js";

export interface CompanyRow {
  id: number;
  name: string;
  name_key: string;
  siren: string | null;
  effectif: string | null; // dormant (ancien registre) — conservé tel quel
  naf_section: string | null; // dormant (ancien registre)
  ca: number | null; // dernier CA connu (€) — dormant
  domain: string | null; // site web
  location: string | null; // localisation (CSV LinkedIn)
  headcount: number | null; // effectif déclaré LinkedIn
  industry: string | null; // secteur LinkedIn
  year_founded: number | null; // année de création
  company_type: string | null; // type (Partnership, Privately Held…)
  added_at: number;
}

// Champs upsertables (tout sauf id/name_key/added_at, gérés à part).
type CompanyData = Partial<Omit<CompanyRow, "id" | "name_key" | "added_at">> & { name: string };

/**
 * Clé de dédoublonnage : nom normalisé (sans accents, formes juridiques, articles,
 * ni contenu entre parenthèses). « L'Oréal (loreal.com) » et « L Oreal SAS »
 * retombent sur la même clé.
 */
function nameTokens(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(sas|sasu|sarl|eurl|sa|sci|group|groupe|holding|france|de|du|des|la|le|les|l|d|et|en|au|aux)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function nameKey(name: string): string {
  return nameTokens(name.replace(/\([^)]*\)/g, " "));
}

// COALESCE à l'update : un ré-ajout ne doit jamais écraser une donnée connue par
// un null (source partielle).
const upsert = db.prepare(`
  INSERT INTO companies
    (name, name_key, siren, effectif, naf_section, ca, domain, location, headcount, industry, year_founded, company_type)
  VALUES
    (@name, @name_key, @siren, @effectif, @naf_section, @ca, @domain, @location, @headcount, @industry, @year_founded, @company_type)
  ON CONFLICT(name_key) DO UPDATE SET
    siren        = COALESCE(excluded.siren, companies.siren),
    effectif     = COALESCE(excluded.effectif, companies.effectif),
    naf_section  = COALESCE(excluded.naf_section, companies.naf_section),
    ca           = COALESCE(excluded.ca, companies.ca),
    domain       = COALESCE(excluded.domain, companies.domain),
    location     = COALESCE(excluded.location, companies.location),
    headcount    = COALESCE(excluded.headcount, companies.headcount),
    industry     = COALESCE(excluded.industry, companies.industry),
    year_founded = COALESCE(excluded.year_founded, companies.year_founded),
    company_type = COALESCE(excluded.company_type, companies.company_type)
`);

// Normalise un jeu de champs partiels en ligne complète pour le bind (tout champ
// absent devient null → COALESCE préserve l'existant).
function bindRow(data: CompanyData, key: string): Record<string, unknown> {
  return {
    name: data.name.trim(),
    name_key: key,
    siren: data.siren ?? null,
    effectif: data.effectif ?? null,
    naf_section: data.naf_section ?? null,
    ca: data.ca ?? null,
    domain: data.domain ?? null,
    location: data.location ?? null,
    headcount: data.headcount ?? null,
    industry: data.industry ?? null,
    year_founded: data.year_founded ?? null,
    company_type: data.company_type ?? null,
  };
}

/** Upsert pur DB : insère/complète une entreprise. Renvoie false si nom inexploitable. */
export function seedCompany(data: CompanyData): boolean {
  const key = nameKey(data.name);
  if (!key) return false;
  upsert.run(bindRow(data, key));
  return true;
}

/** Upsert en masse, dans UNE transaction (rapide pour des milliers de lignes). */
export const seedCompanies = db.transaction((rows: CompanyData[]): number => {
  let n = 0;
  for (const r of rows) if (seedCompany(r)) n++;
  return n;
});

/** Enregistre une entreprise rencontrée pendant une recherche (nom seul, sans réseau). */
export function recordCompany(name: string): void {
  seedCompany({ name });
}

const getDomainByKey = db.prepare("SELECT domain FROM companies WHERE name_key = ?");

/** Domaine déjà connu pour ce nom dans la base (sert de cache à l'enrichissement). */
export function companyDomain(name: string): string | null {
  const key = nameKey(name);
  if (!key) return null;
  const row = getDomainByKey.get(key) as { domain: string | null } | undefined;
  return row?.domain ?? null;
}

// Mots « génériques » qui distinguent rarement deux entreprises : « HERE » et
// « HERE Technologies » sont la même boîte. (Les formes juridiques et « group/
// france » sont déjà retirées par nameTokens ; on complète ici pour le matching.)
const GENERIC_TOKENS = new Set(
  ("technologies technology tech solutions solution software systems system services service " +
    "consulting digital media studio agency labs lab international global partners company co corp " +
    "corporation inc ltd gmbh sarl").split(" ")
);
const coreTokens = (key: string): string[] => key.split(" ").filter((t) => t && !GENERIC_TOKENS.has(t));

// Mots qui, ajoutés à un nom, dénotent une ENTITÉ/activité DISTINCTE (filiale,
// autre métier) : « Apple Bank » ≠ « Apple », « Orange Bank » ≠ « Orange ». On ne
// fusionne JAMAIS sur un préfixe quand le mot ajouté est l'un de ceux-là.
const DISTINCT_ENTITY = new Set(
  ("bank banque capital ventures venture partners partner assurance assurances insurance immobilier " +
    "energie energies eau telecom telecoms mobile music store tv media press presse foundation fondation " +
    "studio retail auto sante health bourse leasing mutuelle business").split(" ")
);

/**
 * Deux noms désignent-ils la MÊME entreprise ? Conservateur (haute précision —
 * on préfère ne pas fusionner que fusionner à tort) :
 *  1. même clé normalisée exacte ;
 *  2. même forme une fois les espaces retirés (« NielsenIQ » ≡ « Nielsen IQ ») ;
 *  3. mêmes tokens DISTINCTIFS, aux mots génériques près (« HERE » ≡ « HERE Technologies ») ;
 *  4. l'un est le PRÉFIXE de l'autre et le(s) mot(s) ajouté(s) sont des noms propres
 *     distinctifs — pas des mots d'entité (« BNP » ≡ « BNP Paribas », « Sopra » ≡
 *     « Sopra Steria » ; mais « Apple » ≠ « Apple Bank »).
 */
export function companiesMatch(aName: string, bName: string): boolean {
  const a = nameKey(aName);
  const b = nameKey(bName);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.replace(/ /g, "") === b.replace(/ /g, "")) return true;
  const ta = coreTokens(a);
  const tb = coreTokens(b);
  if (ta.length && [...ta].sort().join(" ") === [...tb].sort().join(" ")) return true;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (
    short.length >= 1 &&
    short.length < long.length &&
    short.every((t, i) => long[i] === t) && // préfixe exact (ordre conservé)
    long.slice(short.length).every((t) => t.length >= 4 && !DISTINCT_ENTITY.has(t)) // mot ajouté distinctif
  ) {
    return true;
  }
  return false;
}

const byKeyExact = db.prepare("SELECT * FROM companies WHERE name_key = ?");
const byKeyLike = db.prepare("SELECT * FROM companies WHERE name_key LIKE ? LIMIT 200");

/**
 * Cherche en base une entreprise correspondant à `name` : clé exacte d'abord,
 * sinon rapprochement conservateur (companiesMatch) parmi les candidates partageant
 * le token distinctif le plus long. Renvoie la ligne, ou null. Sert à éviter les
 * quasi-doublons (« HERE » / « HERE Technologies ») sans fusionner au hasard.
 */
export function findSimilarCompany(name: string): CompanyRow | null {
  const key = nameKey(name);
  if (!key) return null;
  const exact = byKeyExact.get(key) as CompanyRow | undefined;
  if (exact) return exact;
  const core = coreTokens(key);
  const pivot = [...core].sort((a, b) => b.length - a.length)[0] ?? key.replace(/ /g, "");
  if (pivot.length < 3) return null; // pivot trop court → trop ambigu, on ne rapproche pas
  for (const r of byKeyLike.all(`%${pivot}%`) as CompanyRow[]) {
    if (companiesMatch(name, r.name)) return r;
  }
  return null;
}

export interface CompanyListFilters {
  q?: string; // plein-texte sur name / industry / domain
  headcountMin?: number; // effectif LinkedIn minimum
  headcountMax?: number; // effectif LinkedIn maximum
  industry?: string; // secteur LinkedIn (sous-chaîne)
}

/** Entreprises de la base, filtrées (plus récentes d'abord, max 5000). */
export function listCompanies(f: CompanyListFilters = {}): CompanyRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    conds.push("(name LIKE ? OR industry LIKE ? OR domain LIKE ?)");
    const like = `%${f.q}%`;
    params.push(like, like, like);
  }
  if (f.headcountMin != null) {
    conds.push("headcount >= ?");
    params.push(f.headcountMin);
  }
  if (f.headcountMax != null) {
    conds.push("headcount <= ?");
    params.push(f.headcountMax);
  }
  if (f.industry) {
    conds.push("industry LIKE ?");
    params.push(`%${f.industry}%`);
  }
  return db
    .prepare(`SELECT * FROM companies ${conds.length ? "WHERE " + conds.join(" AND ") : ""} ORDER BY id DESC LIMIT 5000`)
    .all(...params) as CompanyRow[];
}
