/**
 * Job de collecte, un seul à la fois (suivi via jobStatus(), pollé par l'UI) :
 *  1. (optionnel) découverte de pages carrières via l'API de recherche ;
 *  2. (optionnel) job boards des fonds : leurs offres pointent vers l'ATS des
 *     startups (→ nouvelles pages carrières) ; à défaut on visite le site de la
 *     startup pour y trouver son ATS ;
 *  3. (optionnel) sites d'entreprise : on y cherche l'ATS ; à défaut la page
 *     carrières « maison » est lue par un modèle (sessions Claude Code) ;
 *  4. lecture de chaque page carrières suivie, tri France + tech, enregistrement ;
 *  5. (optionnel) offres sans page carrières lisible : restes des job boards des
 *     fonds, Welcome to the Jungle, agrégateurs et recherche publique LinkedIn,
 *     dédoublonnés contre ce qui est déjà connu.
 *
 * Une offre déjà connue est mise à jour (last_seen_at) ; une offre absente d'une
 * page relue avec succès est marquée fermée (closed_at). Une page en erreur ne
 * ferme rien : une panne ne doit pas faire croire que les postes sont pourvus.
 */
import { db } from "./db.js";
import { BoardNotFound, type Posting } from "./ats.js";
import { type BoardAts, type BoardRef, isBoardAts, parseAnyBoardRef, readBoard } from "./boards.js";
import { companyKey } from "./company.js";
import { cleanTitle, isInFrance, techCategory } from "./classify.js";
import { discoverBoards } from "./discover.js";
import { extractJobs } from "./llm.js";
import { type SiteRow, addSite, careersText, nextSites, saveSite, seedSites } from "./sites.js";
import { AGGREGATORS, looksLikeAgency } from "./sources/aggregators.js";
import { type CareersResult, detectCareers } from "./sources/careers.js";
import { fetchLinkedinJobs } from "./sources/linkedin.js";
import { PORTFOLIO_BOARDS, readPortfolioBoard } from "./sources/portfolio-boards.js";
import { fetchWttjJobs } from "./sources/wttj.js";

export interface JobState {
  running: boolean;
  phase: "discover" | "portfolio" | "sites" | "collect" | "feeds" | null;
  done: number; // pages carrières lues
  total: number; // pages carrières à lire
  new_boards: number; // pages découvertes pendant ce job
  new_jobs: number; // offres vues pour la première fois
  open_jobs: number; // offres tech France en ligne vues pendant ce job
  current: string;
  errors: string[];
}

const state: JobState = {
  running: false,
  phase: null,
  done: 0,
  total: 0,
  new_boards: 0,
  new_jobs: 0,
  open_jobs: 0,
  current: "",
  errors: [],
};
let stopRequested = false;

export function jobStatus(): JobState {
  return { ...state, errors: state.errors.slice(0, 20) };
}

export function stopCollect(): boolean {
  if (!state.running) return false;
  stopRequested = true;
  return true;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Exécute `fn` sur chaque élément, `size` à la fois, jusqu'à épuisement ou demande d'arrêt. */
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (!stopRequested && next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: size }, worker));
}

// ─────────────────────────── Pages carrières suivies ───────────────────────────

interface BoardRow {
  ats: BoardAts;
  slug: string;
  company: string | null;
}

const insertBoard = db.prepare("INSERT OR IGNORE INTO boards (ats, slug) VALUES (?, ?)");

/** Ajoute une page carrières à suivre ; false si elle l'était déjà. */
export function addBoard(ref: BoardRef): boolean {
  return insertBoard.run(ref.ats, ref.slug).changes > 0;
}

/** Ajoute une page carrières trouvée pendant le job en cours. */
function trackBoard(ref: BoardRef): void {
  if (addBoard(ref)) state.new_boards++;
}

const MAX_BOARDS_PER_SITE = 5;

/** Pages carrières reconnues par la visite d'un site d'entreprise. */
function boardsFromCareers(r: CareersResult): BoardRef[] {
  const refs = new Map<string, BoardRef>();
  for (const url of r.atsUrls) {
    const ref = parseAnyBoardRef(url);
    if (ref) refs.set(`${ref.ats}:${ref.slug}`, ref);
  }
  // Site carrières Teamtailor sous le domaine de l'entreprise (careers.exemple.com) :
  // aucun lien vers teamtailor.com, mais le flux se lit directement sur cet hôte.
  if (r.platform === "teamtailor" && r.careersUrl) {
    const host = new URL(r.careersUrl).hostname.toLowerCase();
    if (!host.endsWith(".teamtailor.com")) refs.set(`teamtailor:${host}`, { ats: "teamtailor", slug: host });
  }
  return [...refs.values()].slice(0, MAX_BOARDS_PER_SITE);
}

const LOOKS_LIKE_SITE = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(\/\S*)?$/i;

/**
 * Ajout manuel, une entrée par ligne : URL d'offre / de page carrières,
 * « ats:slug », ou site web de l'entreprise (on y cherche alors son ATS ; sans
 * ATS reconnu, le site lui-même est suivi et sa page carrières lue à la collecte).
 */
export async function addBoardsFromText(
  text: string
): Promise<{ added: number; known: number; sites: number; invalid: string[] }> {
  const out = { added: 0, known: 0, sites: 0, invalid: [] as string[] };
  const add = (ref: BoardRef): void => {
    if (addBoard(ref)) out.added++;
    else out.known++;
  };
  for (const line of text.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean)) {
    const ref = parseAnyBoardRef(line);
    if (ref) add(ref);
    else if (LOOKS_LIKE_SITE.test(line)) {
      const host = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`).hostname.replace(/^www\./, "");
      const found = boardsFromCareers(await detectCareers(host));
      if (found.length) found.forEach(add);
      else if (addSite(host, nameFromSlug(host.split(".")[0]))) out.sites++;
      else out.known++;
    } else out.invalid.push(line);
  }
  return out;
}

// ──────────────────────────────── Enregistrement ────────────────────────────────

const upsertJob = db.prepare(`
  INSERT INTO jobs
    (ats, slug, external_id, title, company, company_key, category, department, location, remote, url, description, posted_at,
     agency, first_seen_at, last_seen_at)
  VALUES
    (@ats, @slug, @external_id, @title, @company, @company_key, @category, @department, @location, @remote, @url, @description, @posted_at,
     @agency, @now, @now)
  ON CONFLICT (ats, slug, external_id) DO UPDATE SET
    title = excluded.title,
    company = excluded.company,
    company_key = excluded.company_key,
    category = excluded.category,
    department = excluded.department,
    location = excluded.location,
    remote = excluded.remote,
    url = excluded.url,
    description = COALESCE(excluded.description, jobs.description),
    posted_at = COALESCE(jobs.posted_at, excluded.posted_at),
    agency = excluded.agency,
    last_seen_at = excluded.last_seen_at,
    closed_at = NULL
  RETURNING first_seen_at
`);
const closeMissing = db.prepare(
  "UPDATE jobs SET closed_at = ? WHERE ats = ? AND slug = ? AND closed_at IS NULL AND last_seen_at < ?"
);
const boardOk = db.prepare(
  "UPDATE boards SET company = ?, last_fetched_at = ?, last_count = ?, last_error = NULL WHERE ats = ? AND slug = ?"
);
const boardKo = db.prepare("UPDATE boards SET last_error = ? WHERE ats = ? AND slug = ?");

// Sources sans page carrières (une ligne par offre, rattachée à l'entreprise par company_key).
const FEEDS = ["fonds", "wttj", "arbeitnow", "devitjobs", "linkedin"] as const;
type Feed = (typeof FEEDS)[number];
const FEED_LIST = FEEDS.map((f) => `'${f}'`).join(",");

// La même offre lue en direct sur l'ATS de l'entreprise remplace sa copie agrégée.
const dropFeedCopy = db.prepare(
  `DELETE FROM jobs WHERE ats IN (${FEED_LIST}) AND company_key = ? AND LOWER(title) = LOWER(?)`
);
const knownElsewhere = db.prepare(
  "SELECT 1 FROM jobs WHERE company_key = ? AND LOWER(title) = LOWER(?) AND ats <> ? AND closed_at IS NULL LIMIT 1"
);
// Un flux agrégé ne dit pas qu'une offre est pourvue : on la ferme quand elle n'y figure plus depuis deux semaines.
const FEED_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const closeStaleFeed = db.prepare("UPDATE jobs SET closed_at = ? WHERE ats = ? AND closed_at IS NULL AND last_seen_at < ?");

// Les offres publiées il y a plus de 100 jours ne sont pas gardées (à défaut de
// date de publication, c'est la première collecte où l'offre a été vue qui compte).
const MAX_AGE_MS = 100 * 24 * 60 * 60 * 1000;
const tooOld = (p: Posting, now: number): boolean => p.posted_at !== null && p.posted_at < now - MAX_AGE_MS;
const purgeOld = db.prepare("DELETE FROM jobs WHERE COALESCE(posted_at, first_seen_at) < ?");

/** « mistral-ai » → « Mistral Ai » : nom par défaut quand l'ATS ne donne pas le nom de l'entreprise. */
function nameFromSlug(slug: string): string {
  return slug
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function jobRow(p: Posting, category: string, now: number) {
  return {
    external_id: p.external_id,
    title: p.title,
    category,
    department: p.department,
    location: p.location,
    remote: p.remote ? 1 : 0,
    url: p.url,
    description: p.description,
    posted_at: p.posted_at,
    now,
  };
}

async function collectBoard(board: BoardRow): Promise<void> {
  const postings = await readBoard(board.ats, board.slug);
  const company = postings.find((p) => p.company)?.company ?? board.company ?? nameFromSlug(board.slug);
  const key = companyKey(company);
  const now = Date.now();
  let kept = 0;
  let fresh = 0;
  db.transaction(() => {
    for (const raw of postings) {
      const p = { ...raw, title: cleanTitle(raw.title) };
      const category = isInFrance(p.location, p.country) ? techCategory(p.title, p.department) : null;
      if (!category || tooOld(p, now)) continue;
      kept++;
      const row = upsertJob.get({
        ...jobRow(p, category, now),
        ats: board.ats,
        slug: board.slug,
        company,
        company_key: key,
        agency: 0,
      }) as { first_seen_at: number };
      if (row.first_seen_at === now) fresh++;
      dropFeedCopy.run(key, p.title);
    }
    closeMissing.run(now, board.ats, board.slug, now);
    boardOk.run(company, now, kept, board.ats, board.slug);
  })();
  state.new_jobs += fresh;
  state.open_jobs += kept;
}

/** Enregistre les offres tech France d'un flux agrégé, sauf celles déjà connues par une autre source. */
function storeFeed(feed: Feed, postings: Posting[]): void {
  const now = Date.now();
  let kept = 0;
  let fresh = 0;
  db.transaction(() => {
    for (const raw of postings) {
      const p = { ...raw, title: cleanTitle(raw.title) };
      const key = p.company ? companyKey(p.company) : "";
      const category = isInFrance(p.location, p.country) ? techCategory(p.title, p.department) : null;
      if (!p.company || !key || !category || tooOld(p, now)) continue;
      if (knownElsewhere.get(key, p.title, feed)) continue;
      kept++;
      const row = upsertJob.get({
        ...jobRow(p, category, now),
        ats: feed,
        slug: key,
        company: p.company,
        company_key: key,
        agency: looksLikeAgency(p) ? 1 : 0,
      }) as { first_seen_at: number };
      if (row.first_seen_at === now) fresh++;
    }
    closeStaleFeed.run(now, feed, now - FEED_GRACE_MS);
  })();
  state.new_jobs += fresh;
  state.open_jobs += kept;
}

// ───────────────────────────── Sites d'entreprise ─────────────────────────────

const touchSite = db.prepare("UPDATE sites SET last_checked_at = ? WHERE domain = ?");
const touchSiteJobs = db.prepare("UPDATE jobs SET last_seen_at = ? WHERE ats = 'site' AND slug = ? AND closed_at IS NULL");

/** Enregistre les offres tech France lues sur le site d'une entreprise ; renvoie le nombre retenu. */
function storeSite(site: SiteRow, postings: Posting[]): number {
  const key = companyKey(site.company);
  const now = Date.now();
  let kept = 0;
  let fresh = 0;
  db.transaction(() => {
    for (const raw of postings) {
      const p = { ...raw, title: cleanTitle(raw.title) };
      const category = isInFrance(p.location, p.country) ? techCategory(p.title, p.department) : null;
      if (!category || tooOld(p, now) || knownElsewhere.get(key, p.title, "site")) continue;
      kept++;
      const row = upsertJob.get({
        ...jobRow(p, category, now),
        ats: "site",
        slug: site.domain,
        company: site.company,
        company_key: key,
        agency: 0,
      }) as { first_seen_at: number };
      if (row.first_seen_at === now) fresh++;
    }
    closeMissing.run(now, "site", site.domain, now);
  })();
  state.new_jobs += fresh;
  state.open_jobs += kept;
  return kept;
}

const LLM_BATCH = 25; // pages par session (~60 000 tokens de texte) : un site oublié par le modèle est relu au passage suivant
const LLM_SESSIONS = 2; // sessions Claude Code en parallèle
const SITE_CHUNK = 80; // sites visités puis lus d'une traite : un arrêt ne perd que le lot en cours

/**
 * Visite les `limit` sites les plus anciennement vus. Un ATS reconnu devient une
 * page carrières suivie ; sinon les offres balisées du site sont prises telles
 * quelles, et à défaut le texte de la page carrières est lu par le modèle (sauf
 * s'il n'a pas changé depuis la dernière visite).
 */
async function checkSites(limit: number): Promise<void> {
  seedSites();
  const sites = nextSites(limit);
  for (let i = 0; i < sites.length && !stopRequested; i += SITE_CHUNK) {
    await checkSiteChunk(sites.slice(i, i + SITE_CHUNK), i, sites.length);
  }
}

async function checkSiteChunk(sites: SiteRow[], offset: number, total: number): Promise<void> {
  const toRead: Array<{ site: SiteRow; careersUrl: string; text: string; hash: string }> = [];
  let visited = offset;
  await pool(sites, 6, async (site) => {
    state.current = `site ${++visited}/${total} — ${site.domain}`;
    const r = await detectCareers(site.domain);
    const refs = boardsFromCareers(r);
    refs.forEach(trackBoard);
    if (refs.length) return saveSite(site.domain, { careersUrl: r.careersUrl, status: "ats" });
    if (r.postings.length) {
      return saveSite(site.domain, { careersUrl: r.careersUrl, status: "jobs", count: storeSite(site, r.postings) });
    }
    if (!r.careersUrl) return saveSite(site.domain, { careersUrl: null, status: r.error ? "error" : "none" });
    const page = await careersText(r.careersUrl);
    if (!page) return saveSite(site.domain, { careersUrl: r.careersUrl, status: "error" });
    if (page.hash === site.page_hash) {
      const now = Date.now();
      touchSiteJobs.run(now, site.domain);
      touchSite.run(now, site.domain);
      return;
    }
    toRead.push({ site, careersUrl: r.careersUrl, ...page });
  });

  const batches: (typeof toRead)[] = [];
  for (let i = 0; i < toRead.length; i += LLM_BATCH) batches.push(toRead.slice(i, i + LLM_BATCH));
  let read = 0;
  let failed = false;
  await pool(batches, LLM_SESSIONS, async (batch) => {
    if (failed) return;
    state.current = `sites ${offset + sites.length}/${total} — lecture des pages carrières ${read}/${toRead.length}`;
    let found: Awaited<ReturnType<typeof extractJobs>>;
    try {
      found = await extractJobs(batch.map((b) => ({ id: b.site.domain, company: b.site.company, text: b.text })));
    } catch (err) {
      // session indisponible (Claude Code absent, quota…) : inutile d'insister, les sites seront relus au prochain passage
      failed = true;
      state.errors.push(`lecture des pages carrières : ${errText(err)}`);
      return;
    }
    for (const b of batch) {
      read++;
      const jobs = found.get(b.site.domain);
      if (!jobs) continue; // site oublié par le modèle : relu au prochain passage
      const postings = jobs.map((j): Posting => {
        let url = b.careersUrl;
        try {
          if (j.url && /^https?:$/.test(new URL(j.url, b.careersUrl).protocol)) url = new URL(j.url, b.careersUrl).href;
        } catch {
          // lien illisible : on garde la page carrières
        }
        return {
          external_id: `${companyKey(j.title)}|${companyKey(j.location ?? "")}`,
          title: j.title,
          company: b.site.company,
          department: null,
          location: j.location,
          // base d'entreprises françaises : sans lieu indiqué, le poste est supposé en France
          country: j.location ? null : "France",
          remote: false,
          url,
          description: null,
          posted_at: null,
        };
      });
      const count = storeSite(b.site, postings);
      saveSite(b.site.domain, { careersUrl: b.careersUrl, status: jobs.length ? "jobs" : "empty", pageHash: b.hash, count });
    }
  });
}

// ───────────────────────────── Job boards des fonds ─────────────────────────────

const PORTFOLIO_MAX_REQUESTS = 25; // par job board
const PROBE_MAX_DOMAINS = 300; // sites de startups visités par collecte
const domainProbed = db.prepare("SELECT 1 FROM probed_domains WHERE domain = ?");
const markProbed = db.prepare("INSERT OR REPLACE INTO probed_domains (domain, probed_at, boards) VALUES (?, ?, ?)");

/**
 * Lit les job boards des fonds. Les offres dont l'URL désigne un ATS géré
 * deviennent des pages carrières suivies ; pour les autres startups on visite
 * leur site à la recherche de leur ATS. Renvoie les offres restées sans page
 * carrières (Welcome to the Jungle, site maison…), à enregistrer telles quelles.
 */
async function readPortfolios(): Promise<Posting[]> {
  const leftovers = new Map<string, Posting>(); // par URL : une même offre figure sur plusieurs job boards
  const domains = new Set<string>();
  const track = trackBoard;

  await pool(PORTFOLIO_BOARDS, 3, async (board) => {
    state.current = `job board ${board.name}`;
    const r = await readPortfolioBoard(board, PORTFOLIO_MAX_REQUESTS);
    if (r.error) state.errors.push(`job board ${board.name} : ${r.error}`);
    for (const p of r.postings) {
      const ref = parseAnyBoardRef(p.url);
      if (ref) track(ref);
      else leftovers.set(p.url, { ...p, external_id: p.url });
    }
    for (const c of r.companies) {
      const refs = c.jobUrls.map(parseAnyBoardRef).filter((x): x is BoardRef => x !== null);
      refs.forEach(track);
      if (!refs.length && c.domain) domains.add(c.domain.toLowerCase());
    }
  });

  const todo = [...domains].filter((d) => !domainProbed.get(d)).slice(0, PROBE_MAX_DOMAINS);
  let probed = 0;
  await pool(todo, 6, async (domain) => {
    state.current = `site ${++probed}/${todo.length} — ${domain}`;
    const refs = boardsFromCareers(await detectCareers(domain));
    refs.forEach(track);
    markProbed.run(domain, Date.now(), refs.length);
  });
  return [...leftovers.values()];
}

// ─────────────────────────────────── Le job ───────────────────────────────────

// Agrégateurs branchés (flux publics sans clé, vérifiés en réel).
const AGGREGATOR_KEYS: Feed[] = ["arbeitnow", "devitjobs"];
const LINKEDIN_MAX_REQUESTS = 60; // la recherche publique LinkedIn se ferme vite au-delà

/** Source non officielle : ce qui a été lu avant un éventuel refus est gardé, le refus est signalé. */
async function readUnofficial(
  name: string,
  fetchJobs: () => Promise<{ postings: Posting[]; error: string | null }>
): Promise<Posting[]> {
  state.current = name;
  const r = await fetchJobs();
  if (r.error) state.errors.push(`${name} : ${r.error}`);
  return r.postings;
}
const BOARD_CONCURRENCY = 4;

export interface CollectOptions {
  discover: boolean; // découverte par l'API de recherche
  budget: number; // plafond d'appels payés pour la découverte
  extras: boolean; // job boards des fonds, Welcome to the Jungle, agrégateurs
  linkedin: boolean; // recherche publique LinkedIn
  sites: number; // nombre de sites d'entreprise à visiter (0 = aucun)
}

async function run({ discover, budget, extras, linkedin, sites }: CollectOptions): Promise<void> {
  purgeOld.run(Date.now() - MAX_AGE_MS);
  if (discover) {
    state.phase = "discover";
    try {
      await discoverBoards(
        budget,
        (ref) => {
          if (addBoard(ref)) state.new_boards++;
        },
        () => stopRequested,
        (paid, query) => {
          state.current = `recherche ${paid + 1}/${budget} — ${query}`;
        }
      );
    } catch (err) {
      state.errors.push(`découverte : ${errText(err)}`);
    }
  }

  let leftovers: Posting[] = [];
  if (extras && !stopRequested) {
    state.phase = "portfolio";
    leftovers = await readPortfolios();
  }

  if (sites > 0 && !stopRequested) {
    state.phase = "sites";
    await checkSites(sites);
  }

  state.phase = "collect";
  const boards = (
    db.prepare("SELECT ats, slug, company FROM boards ORDER BY last_fetched_at IS NOT NULL, last_fetched_at").all() as Array<{
      ats: string;
      slug: string;
      company: string | null;
    }>
  ).filter((b): b is BoardRow => isBoardAts(b.ats));
  state.total = boards.length;
  await pool(boards, BOARD_CONCURRENCY, async (board) => {
    state.current = `${board.ats} / ${board.slug}`;
    try {
      await collectBoard(board);
    } catch (err) {
      const msg = errText(err);
      boardKo.run(msg, board.ats, board.slug);
      // un slug inexistant (lien mort, faux positif de la découverte) n'est pas une erreur du job
      if (!(err instanceof BoardNotFound)) state.errors.push(`${board.ats}/${board.slug} : ${msg}`);
    }
    state.done++;
  });

  if (extras && !stopRequested) {
    state.phase = "feeds";
    state.current = "offres des job boards des fonds";
    storeFeed("fonds", leftovers);
    storeFeed("wttj", await readUnofficial("Welcome to the Jungle", () => fetchWttjJobs()));
    for (const key of AGGREGATOR_KEYS) {
      const source = AGGREGATORS.find((a) => a.key === key);
      if (!source || stopRequested) continue;
      state.current = `agrégateur ${source.name}`;
      try {
        storeFeed(key, await source.fetch({ days: 14 }));
      } catch (err) {
        state.errors.push(`${source.name} : ${errText(err)}`);
      }
    }
  }

  if (linkedin && !stopRequested) {
    state.phase = "feeds";
    storeFeed("linkedin", await readUnofficial("LinkedIn (recherche publique)", () => fetchLinkedinJobs({ maxRequests: LINKEDIN_MAX_REQUESTS, hours: 72 })));
  }
}

/** Lance une collecte en tâche de fond ; false si une collecte tourne déjà. */
export function startCollect(options: CollectOptions): boolean {
  if (state.running) return false;
  Object.assign(state, {
    running: true,
    phase: null,
    done: 0,
    total: 0,
    new_boards: 0,
    new_jobs: 0,
    open_jobs: 0,
    current: "",
    errors: [],
  });
  stopRequested = false;
  run(options)
    .catch((err) => state.errors.push(errText(err)))
    .finally(() => {
      state.running = false;
      state.phase = null;
      state.current = "";
    });
  return true;
}
