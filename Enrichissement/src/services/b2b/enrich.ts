/**
 * Jobs de prospection, un seul à la fois (suivi via jobStatus(), pollé par l'UI) :
 * - 'prospect' : recherche directe de personnes par poste — file de requêtes
 *   (terme × localisation × page) déroulée jusqu'au quota de prospects, chaque
 *   profil inséré au fil de l'eau (dédoublonné par slug LinkedIn) ;
 * - 'emails' : pour l'export campagne — devine le domaine de l'entreprise de
 *   chaque prospect, en déduit son adresse (pattern du site + SMTP).
 */
import { db } from "../../db.js";
import { hasCompanyFilters, listCompanies, type CompanyFilters } from "./company.js";
import { crawlEmails, findDomain, normName } from "./domain.js";
import { inferPattern, probeSmtp, resolveEmail } from "./emails.js";
import {
  allEnginesQuarantined,
  allRoleTerms,
  companyQueries,
  fetchProspectsPage,
  isExcluded,
  locationList,
  roleMatches,
  scrapeProspects,
  type PeopleSearchParams,
  type Prospect,
} from "./linkedin.js";
import { hasSearchApi } from "./search.js";

export interface JobState {
  running: boolean;
  mode: "prospect" | "emails";
  target: number; // prospects voulus (mode prospect)
  found: number; // prospects ajoutés (ou emails trouvés en mode emails)
  done: number; // requêtes traitées (ou entreprises traitées en mode emails)
  total: number; // requêtes planifiées (ou entreprises à traiter)
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
  company: CompanyFilters; // filtres taille/secteur/CA (enrichissement registre)
  searchId: number; // scope « recherche en cours » des prospects insérés
  target: number;
  found: number;
  units: Array<{ query: string; page: number }>; // file restante (requête × page)
  dead: Set<string>; // requêtes épuisées (page vide, ou déjà passées en scraping)
  regPage: number | null; // prochaine page du registre à énumérer (null = pas de critère / épuisé)
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
    has_more: Boolean(
      run && (run.units.some((u) => !run!.dead.has(u.query)) || run.regPage !== null)
    ),
  };
}

// Pages de résultats par requête-boîte. 2 suffit : une boîte donnée a peu de
// profils indexés pour un poste précis ; au-delà, Google répète/épuise.
const COMPANY_PAGES = 2;
const NO_API_MSG =
  "Les moteurs publics sont tous en quarantaine (anti-bot) — recherche interrompue, « Chercher plus » " +
  "reprendra plus tard. Pour des résultats fiables et massifs, ajoutez une clé d'API de recherche " +
  "gratuite dans .env (SERPER_API_KEY recommandé, voir .env.example).";

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
function searchIdFor(params: PeopleSearchParams, company: CompanyFilters): number {
  const clean = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = [
    params.roles.map(clean).sort().join(","),
    (params.companies ?? []).map(clean).sort().join(","),
    (params.exclude ?? []).map(clean).sort().join(","),
    clean(params.location),
    clean(params.sector),
    params.franceOnly ? "fr" : "",
    [...(company.effectifs ?? [])].sort().join("+"),
    [...(company.sections ?? [])].sort().join("+"),
    company.caMin ?? "",
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
    (first_name, last_name, role, company, location, linkedin, linkedin_key, search_role, search_id,
     company_effectif, company_section, company_ca)
  VALUES
    (@first_name, @last_name, @role, @company, @location, @linkedin, @linkedin_key, @search_role, @search_id,
     @company_effectif, @company_section, @company_ca)
`);

/**
 * Insère les personnes qui passent les filtres (poste strict, mots-clés exclus,
 * localisation). Renvoie le nombre de nouvelles lignes (dédoublonnées par slug).
 */
function keepProspects(prospects: Prospect[], r: ProspectRun): number {
  let added = 0;
  for (const p of prospects) {
    // précision avant rappel : seuls les postes correspondant à un mot-clé entrent
    if (!roleMatches(p.role, r.terms)) continue;
    // mots-clés bannis dans le titre ou l'entreprise (ex. « senior »)
    if (isExcluded(p.role, r.exclude) || isExcluded(p.company, r.exclude)) continue;
    // localisation demandée : un profil situé ailleurs est écarté (le mot-clé de
    // ville peut matcher n'importe où dans la page) ; lieu inconnu toléré
    if (r.locations.length && p.location && !r.locations.some((l) => normName(p.location!).includes(l))) continue;

    const { changes } = insertProspect.run({
      ...p,
      linkedin_key: linkedinKey(p.linkedin),
      search_role: r.params.roles.join(", "),
      search_id: r.searchId,
      company_effectif: null,
      company_section: null,
      company_ca: null,
    });
    added += changes;
  }
  return added;
}

/**
 * Lance la recherche de personnes en tâche de fond. `cont` reprend la file de
 * la recherche précédente avec `target` prospects EN PLUS (pages suivantes,
 * requêtes restantes). Renvoie false si un job tourne déjà.
 */
export function startProspecting(
  params: PeopleSearchParams,
  company: CompanyFilters,
  target: number,
  cont: boolean
): boolean {
  if (state.running) return false;
  if (cont && run) {
    run.target = run.found + target;
    // sans API, les quarantaines expirent : les requêtes redeviennent tentables
    if (!hasSearchApi()) run.dead.clear();
  } else {
    // TOUJOURS par boîte : on cherche le poste AU SEIN de chaque boîte cible
    // (jamais des personnes au hasard). Les boîtes viennent de la liste fournie
    // par l'utilisateur ET/OU du registre (énumération paginée par taille/secteur,
    // voir refill plus bas). Une requête par boîte = son propre espace de résultats.
    run = {
      params,
      terms: allRoleTerms(params.roles),
      exclude: params.exclude ?? [],
      locations: locationList(params.location).map(normName),
      company,
      searchId: searchIdFor(params, company),
      target,
      found: 0,
      units: companyUnits(params, params.companies ?? []),
      dead: new Set(),
      // critères registre présents → on énumère aussi des boîtes depuis le registre
      regPage: hasCompanyFilters(company) ? 1 : null,
    };
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
    // Énumération du registre (mode critères taille/secteur) : quand la file de
    // boîtes est vide, on tire un lot d'entreprises du registre et on enfile leurs
    // requêtes. regPage avance pour que « chercher plus » reprenne au lot suivant.
    const refill = async (): Promise<void> => {
      if (r.regPage === null) return;
      state.current = "énumération des entreprises (registre)…";
      const batch = Math.min(600, Math.max(100, (r.target - r.found) * 3));
      const { companies, nextPage } = await listCompanies(r.company, batch, r.regPage);
      r.regPage = nextPage;
      r.units.push(...companyUnits(r.params, companies.map((c) => c.name)));
      state.total = state.done + r.units.filter((u) => !r.dead.has(u.query)).length;
    };
    try {
      while (r.found < r.target) {
        if (cancelRequested) break; // bouton « Arrêter »
        if (!r.units.length) {
          await refill();
          if (!r.units.length) break;
        }
        const unit = r.units.shift()!;
        if (r.dead.has(unit.query)) continue;
        state.current = unit.query.replace(/^site:\S+\s+/, ""); // libellé lisible
        let prospects: Prospect[];
        const api = await fetchProspectsPage(unit.query, unit.page, r.terms);
        if (api !== null) {
          prospects = api.prospects;
          if (api.raw === 0) r.dead.add(unit.query); // page vide → requête épuisée
        } else if (hasSearchApi()) {
          // une clé API est configurée mais le provider est en panne/quota/limite
          // de débit : le repli scraping ne donne rien pour des requêtes par boîte.
          // On informe clairement (au lieu d'un 0 silencieux) et on s'arrête ;
          // « Chercher plus » reprendra la file quand le provider sera rétabli.
          state.errors.push(
            "Moteur de recherche (Serper) momentanément indisponible — quota épuisé ou limite de débit. " +
              "Réessayez dans quelques minutes ; « Chercher plus » reprendra la file."
          );
          break;
        } else {
          // pas d'API du tout : scraping public — une seule passe par requête
          if (unit.page > 0) {
            r.dead.add(unit.query);
            continue;
          }
          prospects = (await scrapeProspects(unit.query, r.terms, { engines: 3, pages: 2 })) ?? [];
          r.dead.add(unit.query);
          if (!prospects.length && allEnginesQuarantined()) {
            state.errors.push(NO_API_MSG);
            break;
          }
        }
        const added = keepProspects(prospects, r);
        r.found += added;
        state.found = r.found;
        state.done++;
      }
    } catch (err) {
      state.errors.push(err instanceof Error ? err.message : String(err));
    }
    state.running = false;
    state.current = null;
  })();
  return true;
}

// --- Emails (optionnel, pour l'export campagne) -------------------------------

/** Domaine HELO pour le dialogue SMTP : celui du premier compte connecté. */
function heloDomain(): string {
  const row = db.prepare("SELECT email FROM accounts WHERE active = 1 ORDER BY id LIMIT 1").get() as
    | { email: string }
    | undefined;
  return row?.email.split("@")[1] ?? "example.com";
}

interface ProspectRow {
  id: number;
  first_name: string;
  last_name: string;
  company: string | null;
}

/**
 * Cherche l'email professionnel des prospects donnés : domaine deviné depuis
 * le nom d'entreprise, pattern d'adressage du site, vérification SMTP quand
 * c'est possible. Renvoie false si un job tourne déjà.
 */
export function startEmailJob(ids: number[]): boolean {
  if (state.running) return false;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, first_name, last_name, company FROM prospects WHERE id IN (${placeholders}) AND email IS NULL`
    )
    .all(...ids) as ProspectRow[];

  // sans entreprise, pas de domaine à chercher
  const noCompany = rows.filter((p) => !p.company);
  const setStatus = db.prepare("UPDATE prospects SET email_status = ? WHERE id = ?");
  for (const p of noCompany) setStatus.run("no_domain", p.id);

  const groups = new Map<string, ProspectRow[]>();
  for (const p of rows) {
    if (!p.company) continue;
    const key = p.company.toLowerCase();
    if (groups.has(key)) groups.get(key)!.push(p);
    else groups.set(key, [p]);
  }

  cancelRequested = false;
  state.running = true;
  state.mode = "emails";
  state.target = 0;
  state.found = 0;
  state.done = 0;
  state.total = groups.size;
  state.current = null;
  state.errors = [];

  const helo = heloDomain();
  const updEmail = db.prepare("UPDATE prospects SET email = ?, email_status = ? WHERE id = ?");
  void (async () => {
    // 2 entreprises en parallèle : assez rapide sans matraquer les sites
    const queue = [...groups.values()];
    const worker = async () => {
      for (let group = queue.shift(); group; group = queue.shift()) {
        if (cancelRequested) break; // bouton « Arrêter »
        const company = group[0].company!;
        state.current = company;
        try {
          const dom = await findDomain({ name: company, brand: null, ville: null });
          if (!dom) {
            for (const p of group) setStatus.run("no_domain", p.id);
          } else {
            const { emails } = await crawlEmails(dom.domain, dom.homepage);
            const pattern = inferPattern(emails, group);
            const probe = await probeSmtp(dom.domain, helo);
            try {
              for (const p of group) {
                const r = await resolveEmail(p.first_name, p.last_name, dom.domain, pattern, probe);
                updEmail.run(r.email, r.status, p.id);
                if (r.email) state.found++;
              }
            } finally {
              probe.close();
            }
          }
        } catch (err) {
          state.errors.push(`${company} : ${err instanceof Error ? err.message : err}`);
        }
        state.done++;
      }
    };
    await Promise.all([worker(), worker()]);
    state.running = false;
    state.current = null;
  })();
  return true;
}
