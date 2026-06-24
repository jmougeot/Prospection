/**
 * Job de prospection, un seul à la fois (suivi via jobStatus(), pollé par l'UI) :
 * recherche directe de personnes par poste — file de requêtes (terme ×
 * localisation × page) déroulée jusqu'au quota de prospects, chaque profil
 * inséré au fil de l'eau (dédoublonné par slug LinkedIn).
 */
import { db } from "../../db.js";
import { findSimilarCompany, listCompanies, nameKey, recordCompany, seedCompany, type CompanyListFilters } from "./companies.js";
import { findDomain, normName } from "./domain.js";
import {
  allRoleTerms,
  companyQueries,
  fetchProspectsPage,
  fillMissingCompany,
  isExcluded,
  locationList,
  roleMatches,
  type PeopleSearchParams,
  type Prospect,
} from "./linkedin.js";

export interface JobState {
  running: boolean;
  mode: "prospect";
  target: number; // prospects voulus
  found: number; // prospects ajoutés
  done: number; // requêtes traitées
  total: number; // requêtes planifiées
  current: string | null; // requête ou entreprise en cours
  errors: string[];
}

const state: JobState = {
  running: false,
  mode: "prospect",
  target: 0,
  found: 0,
  done: 0,
  total: 0,
  current: null,
  errors: [],
};

interface ProspectRun {
  params: PeopleSearchParams;
  terms: string[]; // termes acceptés au filtrage (postes exacts + équivalents)
  exclude: string[]; // mots-clés bannis (titre/entreprise)
  locations: string[]; // localisations demandées, normalisées (filtrage)
  company: CompanyListFilters; // filtre de sélection des entreprises enrichies (headcount/industry)
  searchId: number; // scope « recherche en cours » des prospects insérés
  target: number;
  found: number;
  units: Array<{ query: string; page: number }>; // file restante (requête × page)
  dead: Set<string>; // requêtes épuisées (page vide)
}

// Dernière recherche : sert aussi après la fin du job (scope du tableau,
// bouton « chercher plus » qui reprend la file où elle s'est arrêtée).
let run: ProspectRun | null = null;

// Demande d'arrêt du job en cours (bouton « Arrêter ») : la boucle la vérifie et
// s'interrompt proprement à l'itération suivante. « Chercher plus » reprend après.
let cancelRequested = false;

/** Demande l'arrêt du job en cours. Renvoie false si rien ne tourne. */
export function stopProspecting(): boolean {
  if (!state.running) return false;
  cancelRequested = true;
  state.current = "arrêt en cours…";
  return true;
}

export function currentSearchId(): number | null {
  return run?.searchId ?? null;
}

export function jobStatus(): JobState & { search_id: number | null; has_more: boolean } {
  return {
    ...state,
    errors: [...state.errors],
    search_id: run?.searchId ?? null,
    has_more: Boolean(run && run.units.some((u) => !run!.dead.has(u.query))),
  };
}

// Pages de résultats par requête-boîte. 2 suffit : une boîte donnée a peu de
// profils indexés pour un poste précis ; au-delà, Google répète/épuise.
const COMPANY_PAGES = 2;

/**
 * File de requêtes pour un lot de boîtes : pour chaque boîte, ses requêtes
 * (1-2 sous-domaines) sur COMPANY_PAGES pages, en largeur d'abord (page 0 de
 * toutes les boîtes, puis page 1…) pour que les premiers profils viennent d'un
 * maximum de boîtes différentes.
 */
function companyUnits(params: PeopleSearchParams, names: string[]): ProspectRun["units"] {
  const units: ProspectRun["units"] = [];
  for (let page = 0; page < COMPANY_PAGES; page++)
    for (const name of names) for (const query of companyQueries(params, name)) units.push({ query, page });
  return units;
}

/**
 * Identifiant stable d'une recherche : les mêmes paramètres (poste,
 * localisation, secteur) retombent sur le même scope — relancer la recherche
 * demain accumule dans le même tableau au lieu d'en repartir un nouveau.
 */
function searchIdFor(params: PeopleSearchParams, company: CompanyListFilters): number {
  const clean = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = [
    params.roles.map(clean).sort().join(","),
    (params.companies ?? []).map(clean).sort().join(","),
    (params.exclude ?? []).map(clean).sort().join(","),
    clean(params.location),
    clean(params.sector),
    params.franceOnly ? "fr" : "",
    company.headcountMin ?? "",
    company.headcountMax ?? "",
    clean(company.industry),
  ].join("|");
  const row = db.prepare("SELECT search_id FROM searches WHERE key = ?").get(key) as
    | { search_id: number }
    | undefined;
  if (row) return row.search_id;
  const id = Date.now();
  db.prepare("INSERT INTO searches (key, search_id) VALUES (?, ?)").run(key, id);
  return id;
}

/** Slug normalisé d'une URL de profil : identité du prospect (dédoublonnage). */
function linkedinKey(url: string): string {
  let slug = url.split("/in/")[1] ?? url;
  try {
    slug = decodeURIComponent(slug);
  } catch {
    /* encodage partiel : on garde brut */
  }
  return slug.toLowerCase().replace(/\/+$/, "");
}

const insertProspect = db.prepare(`
  INSERT OR IGNORE INTO prospects
    (first_name, last_name, role, company, company_domain, company_headcount_est, company_revenue_est,
     location, linkedin, linkedin_key, search_role, search_id)
  VALUES
    (@first_name, @last_name, @role, @company, @company_domain, @company_headcount_est, @company_revenue_est,
     @location, @linkedin, @linkedin_key, @search_role, @search_id)
`);

/**
 * Insère les personnes qui passent les filtres (poste strict, mots-clés exclus,
 * localisation). Renvoie le nombre de nouvelles lignes (dédoublonnées par slug).
 */
async function keepProspects(prospects: Prospect[], r: ProspectRun): Promise<number> {
  let added = 0;
  for (const p of prospects) {
    // précision avant rappel : seuls les postes correspondant à un mot-clé entrent
    if (!roleMatches(p.role, r.terms)) continue;
    // mot-clé banni dans le poste (ex. « senior ») — filtre bon marché, avant tout réseau
    if (isExcluded(p.role, r.exclude)) continue;
    // On enregistre TOUS les prospects, même hors France : le tri « France » se
    // fait à la lecture (liste/export) en filtrant sur le sous-domaine
    // fr.linkedin.com (cf. routes.ts) — signal bien plus fiable qu'une heuristique
    // de lieu (« Austin », « Greater Boston »… passaient au travers).
    // Localisation explicitement demandée : un profil situé ailleurs est écarté
    // (le mot-clé de ville peut matcher n'importe où dans la page) ; lieu inconnu toléré.
    if (r.locations.length && p.location && !r.locations.some((l) => normName(p.location!).includes(l))) continue;
    // entreprise inconnue : on tente de la retrouver (re-requête nominative) AVANT
    // le filtre d'exclusion entreprise — seulement pour les profils qui passent
    // déjà les filtres ci-dessus, pour ne pas dépenser de requête inutilement.
    if (!p.company) await fillMissingCompany(p);
    // mot-clé banni dans l'entreprise (désormais éventuellement enrichie)
    if (isExcluded(p.company, r.exclude)) continue;

    const { changes } = insertProspect.run({
      first_name: p.first_name,
      last_name: p.last_name,
      role: p.role,
      company: p.company,
      company_domain: p.company_domain,
      company_headcount_est: p.headcount_est,
      company_revenue_est: p.revenue_est,
      location: p.location,
      linkedin: p.linkedin,
      linkedin_key: linkedinKey(p.linkedin),
      search_role: r.params.roles.join(", "),
      search_id: r.searchId,
    });
    added += changes;
  }
  return added;
}

/** Mélange en place (Fisher-Yates) et renvoie le tableau. */
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Exécute `fn` sur les éléments avec une concurrence bornée (rapide, sans rafale). */
async function mapPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
const DOMAIN_CONCURRENCY = 8;

const distinctSearchCompanies = db.prepare(
  "SELECT DISTINCT company FROM prospects WHERE search_id = ? AND company IS NOT NULL AND company <> ''"
);
const existingProspectDomain = db.prepare(
  "SELECT company_domain FROM prospects WHERE search_id = ? AND company = ? AND company_domain IS NOT NULL AND company_domain <> '' LIMIT 1"
);
const getCompanyByKey = db.prepare("SELECT id, domain FROM companies WHERE name_key = ?");
const setProspectCompany = db.prepare(
  "UPDATE prospects SET company_id = ?, company_domain = ? WHERE search_id = ? AND company = ?"
);

/**
 * Lie chaque prospect à une entreprise (clé étrangère company_id), pour cliquer
 * dessus et voir la fiche. Par boîte distincte de la recherche :
 *  1. déjà en base → on lie (et on aligne le domaine du prospect sur celui de la fiche) ;
 *  2. absente → on cherche son domaine (déjà extrait par le modèle, sinon findDomain) :
 *     trouvé → on crée la boîte (avec domaine) et on lie ; rien → on ne crée pas la boîte
 *     (mauvais signe) et le prospect reste sans lien (company_id null).
 * Le même lien/domaine s'applique à toutes les fiches de la boîte. Concurrence bornée.
 */
async function linkProspectCompanies(searchId: number): Promise<void> {
  const companies = (distinctSearchCompanies.all(searchId) as Array<{ company: string }>).map((r) => r.company);
  await mapPool(companies, DOMAIN_CONCURRENCY, async (name) => {
    // rapprochement conservateur : clé exacte OU variante sûre (HERE / HERE Technologies)
    let row: { id: number; domain: string | null } | null = findSimilarCompany(name);
    if (!row) {
      let domain = (existingProspectDomain.get(searchId, name) as { company_domain: string } | undefined)?.company_domain ?? null;
      if (!domain) {
        const res = await findDomain({ name, brand: null, ville: null }).catch(() => null);
        domain = res?.domain ?? null;
      }
      if (domain) {
        seedCompany({ name, domain });
        row = (getCompanyByKey.get(nameKey(name)) as { id: number; domain: string | null } | undefined) ?? null;
      }
    }
    setProspectCompany.run(row?.id ?? null, row?.domain ?? null, searchId, name);
  });
}

// Bruit : un nom de plus de 3 mots SANS domaine est presque toujours une tagline
// captée par erreur (« Helping companies grow with… ») — on l'écarte avant findDomain.
const deleteNoisyCompanies = db.prepare(
  "DELETE FROM companies WHERE (domain IS NULL OR domain = '') " +
    "AND (length(trim(name)) - length(replace(trim(name), ' ', ''))) >= 3"
);
const companiesMissingDomain = db.prepare("SELECT id, name FROM companies WHERE domain IS NULL OR domain = ''");
const setCompanyDomainById = db.prepare("UPDATE companies SET domain = ? WHERE id = ?");
const deleteCompanyById = db.prepare("DELETE FROM companies WHERE id = ?");
const unlinkProspectsOfCompany = db.prepare("UPDATE prospects SET company_id = NULL WHERE company_id = ?");

/**
 * Maintenance de TOUTE la base d'entreprises : (1) suppression du bruit (noms de
 * plus de 3 mots sans domaine) ; (2) pour les entreprises restantes sans domaine,
 * findDomain — trouvé → on stocke, introuvable → on SUPPRIME l'entrée. Converge :
 * l'ensemble « sans domaine » rétrécit à chaque passe. Concurrence bornée.
 */
export async function maintainCompanyBase(
  onProgress?: (done: number, total: number) => void
): Promise<{ noise: number; found: number; deleted: number }> {
  const noise = deleteNoisyCompanies.run().changes;
  const rows = companiesMissingDomain.all() as Array<{ id: number; name: string }>;
  let found = 0;
  let deleted = 0;
  let done = 0;
  await mapPool(rows, DOMAIN_CONCURRENCY, async (c) => {
    const res = await findDomain({ name: c.name, brand: null, ville: null }).catch(() => null);
    if (res?.domain) {
      setCompanyDomainById.run(res.domain, c.id);
      found++;
    } else {
      unlinkProspectsOfCompany.run(c.id); // évite les liens orphelins
      deleteCompanyById.run(c.id);
      deleted++;
    }
    onProgress?.(++done, rows.length);
  });
  return { noise, found, deleted };
}

/**
 * Lance la recherche de personnes en tâche de fond. `cont` reprend la file de
 * la recherche précédente avec `target` prospects EN PLUS (pages suivantes,
 * requêtes restantes). Renvoie false si un job tourne déjà.
 */
export function startProspecting(
  params: PeopleSearchParams,
  company: CompanyListFilters,
  target: number,
  cont: boolean
): boolean {
  if (state.running) return false;
  if (cont && run) {
    run.target = run.found + target;
  } else {
    // TOUJOURS par boîte : on cherche le poste AU SEIN de chaque boîte cible. Les
    // boîtes viennent de la liste fournie ET/OU d'une sélection dans la base
    // d'entreprises DÉJÀ ENRICHIES (filtre headcount/industry). Une requête par
    // boîte = son propre espace de résultats.
    const fromDb =
      company.headcountMin != null || company.headcountMax != null || company.industry
        ? listCompanies(company).map((c) => c.name)
        : [];
    // Mélange aléatoire des boîtes de la base : sans ça, l'ordre fixe (id DESC) fait
    // qu'on retombe toujours sur les mêmes premières entreprises d'un run à l'autre.
    // La liste fournie à la main reste prioritaire (en tête).
    const names = [...new Set([...(params.companies ?? []), ...shuffle(fromDb)])];
    run = {
      params,
      terms: allRoleTerms(params.roles),
      exclude: params.exclude ?? [],
      locations: locationList(params.location).map(normName),
      company,
      searchId: searchIdFor(params, company),
      target,
      found: 0,
      units: companyUnits(params, names),
      dead: new Set(),
    };
    // les boîtes saisies à la main entrent dans la base d'entreprises
    for (const name of params.companies ?? []) recordCompany(name);
  }
  const r = run;

  cancelRequested = false;
  state.running = true;
  state.mode = "prospect";
  state.target = r.target;
  state.found = r.found;
  state.done = 0;
  state.total = r.units.filter((u) => !r.dead.has(u.query)).length;
  state.current = null;
  state.errors = [];

  void (async () => {
    try {
      while (r.found < r.target) {
        if (cancelRequested) break; // bouton « Arrêter »
        if (!r.units.length) break; // file épuisée
        const unit = r.units.shift()!;
        if (r.dead.has(unit.query)) continue;
        state.current = unit.query.replace(/^site:\S+\s+/, ""); // libellé lisible
        const api = await fetchProspectsPage(unit.query, unit.page);
        if (api === null) {
          // une clé est configurée mais le provider est tombé (quota/débit) : on
          // s'arrête proprement ; « Chercher plus » reprendra la file ensuite.
          state.errors.push(
            "Moteur de recherche momentanément indisponible — quota épuisé ou limite de débit. " +
              "Réessayez dans quelques minutes ; « Chercher plus » reprendra la file."
          );
          break;
        }
        if (api.raw === 0) r.dead.add(unit.query); // page vide → requête épuisée
        const added = await keepProspects(api.prospects, r);
        r.found += added;
        state.found = r.found;
        state.done++;
      }
      // Recherche terminée OU arrêtée : on complète quand même les domaines (vite,
      // en parallèle), puis on nettoie/complète toute la base d'entreprises.
      state.current = "liaison des entreprises (domaines)…";
      await linkProspectCompanies(r.searchId);
      state.current = "nettoyage des domaines de la base…";
      await maintainCompanyBase();
    } catch (err) {
      state.errors.push(err instanceof Error ? err.message : String(err));
    }
    state.running = false;
    state.current = null;
  })();
  return true;
}

