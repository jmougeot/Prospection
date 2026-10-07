/**
 * Routes de la collecte d'offres : lancement / suivi du job, pages carrières
 * suivies, tableau des offres et export CSV.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import type express from "express";
import { db } from "./db.js";
import { isAlternance } from "./classify.js";
import { addBoardsFromText, jobStatus, startCollect, stopCollect } from "./collect.js";
import { companyKey } from "./company.js";
import { config } from "./config.js";
import { addManualContact, profileUrl } from "./contact.js";
import { hasSearchApi } from "./discover.js";

const DAY = 24 * 60 * 60 * 1000;

// Fonction SQL du filtre ?hide_alternance=1 : l'intitulé annonce-t-il une alternance ?
db.function("is_alternance", { deterministic: true }, (title) => (isAlternance(String(title ?? "")) ? 1 : 0));

interface JobRow {
  id: number;
  ats: string;
  title: string;
  company: string;
  company_key: string;
  category: string;
  department: string | null;
  location: string | null;
  remote: number;
  url: string;
  posted_at: number | null;
  modified_at: number | null;
  first_seen_at: number;
  since: number; // début de l'ancienneté affichée (voir SINCE)
  closed_at: number | null;
  agency: number; // 1 = annonce probablement publiée par un cabinet ou une ESN
  company_open: number; // offres tech France en ligne dans la même entreprise
  headcount: number | null; // effectif de l'entreprise (null si inconnu)
  days_open: number; // jours en ligne (jusqu'à la fermeture si l'offre est fermée)
  days_modified: number | null; // jours depuis la dernière modification de la page de l'offre (null : inconnue ou jamais retouchée)
  // personne à contacter dans l'entreprise (null si aucune n'a été trouvée ou cherchée)
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_role: string | null;
  contact_linkedin: string | null;
  contact_confidence: string | null; // haute | moyenne | faible
  contact_reason: string | null;
  // second contact de l'entreprise, gardé à côté du premier (null s'il n'y en a pas)
  contact2_first_name: string | null;
  contact2_last_name: string | null;
  contact2_role: string | null;
  contact2_linkedin: string | null;
}

// Date depuis laquelle une offre est en ligne : sa publication ; à défaut, le plus ancien
// signe qu'on en a (première collecte, ou dernière modification de sa page si elle est antérieure).
const SINCE = (t = ""): string => `COALESCE(${t}posted_at, MIN(${t}first_seen_at, COALESCE(${t}modified_at, ${t}first_seen_at)))`;

/** Jours écoulés depuis la dernière modification de la page d'une offre ; null si elle est inconnue ou si la page n'a pas été retouchée depuis. */
const daysModified = (modified: number | null, since: number, now: number): number | null =>
  modified !== null && modified - since >= DAY ? Math.max(0, Math.floor((now - modified) / DAY)) : null;

function queryJobs(query: Record<string, unknown>): JobRow[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  // ?status=open (défaut) | closed | all
  if (query.status === "closed") conds.push("j.closed_at IS NOT NULL");
  else if (query.status !== "all") conds.push("j.closed_at IS NULL");
  if (typeof query.category === "string" && query.category) {
    conds.push("j.category = ?");
    params.push(query.category);
  }
  if (query.q) {
    conds.push("(j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ?)");
    const like = `%${String(query.q)}%`;
    params.push(like, like, like);
  }
  // ?hide_agency=1 : écarte les sociétés de conseil, ESN, agences et cabinets de recrutement — entreprises classées
  // ou signalées comme telles ; à défaut de classement, annonces qui en ont l'air (le classement de l'entreprise
  // l'emporte sur l'allure d'une annonce)
  if (query.hide_agency === "1") {
    conds.push("COALESCE(t.type, '') NOT IN ('conseil_esn_agence', 'cabinet_recrutement') AND COALESCE(f.flag, '') <> 'conseil_ou_cabinet' AND (j.agency = 0 OR t.type IS NOT NULL)");
  }
  // ?hide_alternance=1 : écarte les alternances (d'après l'intitulé) et les offres des écoles et organismes d'alternance
  if (query.hide_alternance === "1") {
    conds.push("NOT is_alternance(j.title) AND COALESCE(t.type, '') <> 'ecole' AND COALESCE(f.flag, '') <> 'ecole'");
  }
  // ?min_size= / ?max_size= : effectif de l'entreprise ; une borne écarte les entreprises de taille inconnue
  for (const [name, op] of [["min_size", ">="], ["max_size", "<="]] as const) {
    const bound = Number(query[name]);
    if (query[name] && Number.isFinite(bound) && bound >= 0) {
      conds.push(`s.headcount ${op} ?`);
      params.push(bound);
    }
  }
  if (query.ids) {
    const ids = String(query.ids).split(",").map(Number).filter(Number.isFinite);
    if (ids.length) {
      conds.push(`j.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }
  // ?keys=alan,qonto : entreprises choisies (sélection du tableau)
  if (query.keys) {
    const keys = String(query.keys).split(",").filter(Boolean);
    if (keys.length) {
      conds.push(`j.company_key IN (${keys.map(() => "?").join(",")})`);
      params.push(...keys);
    }
  }
  const now = Date.now();
  const minDays = Math.max(0, Number(query.min_days) || 0);
  const minOpen = Math.max(0, Number(query.min_open) || 0);
  const rows = db
    .prepare(
      `SELECT j.id, j.ats, j.title, j.company, j.company_key, j.category, j.department, j.location, j.remote, j.url,
              j.posted_at, j.modified_at, j.first_seen_at, ${SINCE("j.")} AS since, j.closed_at, j.agency,
              (SELECT COUNT(*) FROM jobs o WHERE o.company_key = j.company_key AND o.closed_at IS NULL) AS company_open,
              s.headcount,
              c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.role AS contact_role,
              c.linkedin AS contact_linkedin, c.confidence AS contact_confidence, c.reason AS contact_reason,
              c2.first_name AS contact2_first_name, c2.last_name AS contact2_last_name, c2.role AS contact2_role,
              c2.linkedin AS contact2_linkedin
       FROM jobs j
       LEFT JOIN contacts c ON c.company_key = j.company_key AND c.confidence <> 'aucune'
       LEFT JOIN second_contacts c2 ON c2.company_key = j.company_key
       LEFT JOIN company_sizes s ON s.company_key = j.company_key
       LEFT JOIN company_types t ON t.company_key = j.company_key
       LEFT JOIN company_flags f ON f.company_key = j.company_key
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY (j.posted_at IS NULL AND j.modified_at IS NULL), since DESC -- offres sans aucune date en fin de liste
       LIMIT 5000`
    )
    .all(...params) as Array<Omit<JobRow, "days_open" | "days_modified">>;
  return rows
    .map((r) => ({
      ...r,
      days_open: Math.max(0, Math.floor(((r.closed_at ?? now) - r.since) / DAY)),
      days_modified: daysModified(r.modified_at, r.since, now),
    }))
    .filter((r) => r.days_open >= minDays && r.company_open >= minOpen);
}

/** Une entreprise à prospecter : sa plus récente offre retenue par les filtres, et combien d'offres le sont. */
interface CompanyRow extends JobRow {
  offers: number;
}

/**
 * Une ligne par entreprise, mêmes filtres que les offres. Les entreprises sont classées par offre la plus
 * récente (queryJobs rend les offres dans cet ordre : la première rencontrée d'une entreprise est sa plus récente).
 */
function queryCompanies(query: Record<string, unknown>): CompanyRow[] {
  const byKey = new Map<string, CompanyRow>();
  for (const job of queryJobs(query)) {
    const row = byKey.get(job.company_key);
    if (!row) byKey.set(job.company_key, { ...job, offers: 1 });
    else {
      row.offers++;
      row.agency ||= job.agency;
    }
  }
  return [...byKey.values()];
}

interface EnrichedCompany {
  domain: string | null;
  location: string | null;
  industry: string | null;
  year_founded: number | null;
  siren: string | null;
  ca: number | null;
}
// Fiches de la base Enrichissement (lue seule) par company_key, relues au plus toutes les 10 minutes.
let enriched: { at: number; byKey: Map<string, EnrichedCompany> } | null = null;
function enrichedCompany(key: string): EnrichedCompany | null {
  if (!enriched || Date.now() - enriched.at > 10 * 60 * 1000) {
    const byKey = new Map<string, EnrichedCompany>();
    if (fs.existsSync(config.enrichissementDb)) {
      const source = new Database(config.enrichissementDb, { readonly: true, fileMustExist: true });
      try {
        const rows = source.prepare("SELECT name, domain, location, industry, year_founded, siren, ca FROM companies").all() as Array<EnrichedCompany & { name: string }>;
        for (const { name, ...info } of rows) if (companyKey(name)) byKey.set(companyKey(name), info);
      } catch {
        // base d'un autre format : la fiche s'affiche sans ces informations
      } finally {
        source.close();
      }
    }
    enriched = { at: Date.now(), byKey };
  }
  return enriched.byKey.get(key) ?? null;
}

/** Tout ce qu'on sait d'une entreprise : taille, nature, contact, site, pages carrières et offres en ligne. */
function companyCard(key: string) {
  const jobs = db
    .prepare(
      `SELECT id, title, company, category, location, remote, url, ats, agency, posted_at, modified_at,
              ${SINCE()} AS since
       FROM jobs WHERE company_key = ? AND closed_at IS NULL ORDER BY (posted_at IS NULL AND modified_at IS NULL), since DESC`
    )
    .all(key) as Array<{ company: string; since: number; ats: string; posted_at: number | null; modified_at: number | null }>;
  const last = db.prepare("SELECT company FROM jobs WHERE company_key = ? ORDER BY last_seen_at DESC LIMIT 1").get(key) as { company: string } | undefined;
  if (!last) return null;
  const now = Date.now();
  return {
    key,
    name: jobs[0]?.company ?? last.company,
    closed_jobs: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE company_key = ? AND closed_at IS NOT NULL").get(key) as { n: number }).n,
    size: db.prepare("SELECT headcount, source FROM company_sizes WHERE company_key = ?").get(key) ?? null,
    type: db.prepare("SELECT type, reason FROM company_types WHERE company_key = ?").get(key) ?? null,
    flag: (db.prepare("SELECT flag FROM company_flags WHERE company_key = ?").get(key) as { flag: string } | undefined)?.flag ?? null,
    contact: db.prepare("SELECT first_name, last_name, role, linkedin, confidence, reason FROM contacts WHERE company_key = ?").get(key) ?? null,
    contact2: db.prepare("SELECT first_name, last_name, role, linkedin, confidence, reason FROM second_contacts WHERE company_key = ?").get(key) ?? null,
    site: db.prepare("SELECT domain, careers_url FROM sites WHERE company = ? OR domain IN (SELECT slug FROM jobs WHERE company_key = ? AND ats = 'site') LIMIT 1").get(jobs[0]?.company ?? last.company, key) ?? null,
    enriched: enrichedCompany(key),
    sources: [...new Set(jobs.map((j) => j.ats))],
    jobs: jobs.map((j) => ({
      ...j,
      days_open: Math.max(0, Math.floor((now - j.since) / DAY)),
      days_modified: daysModified(j.modified_at, j.since, now),
    })),
  };
}

export function registerRoutes(app: express.Express): void {
  app.get("/api/meta", (_req, res) => {
    const boards = db.prepare("SELECT COUNT(*) AS n, COUNT(last_fetched_at) AS ok FROM boards").get() as { n: number; ok: number };
    const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE closed_at IS NULL").get() as { n: number };
    const sites = db.prepare("SELECT COUNT(*) AS n, COUNT(last_checked_at) AS seen FROM sites").get() as { n: number; seen: number };
    res.json({ search_api: hasSearchApi(), boards: boards.n, boards_read: boards.ok, open_jobs: jobs.n, sites: sites.n, sites_seen: sites.seen });
  });

  // --- Collecte (job en tâche de fond) ---
  app.post("/api/collect", (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const discover = Boolean(b.discover);
    if (discover && !hasSearchApi()) {
      return res.status(400).json({ error: "La découverte exige une clé d'API de recherche (SERPER_API_KEY) dans .env." });
    }
    // plafond d'appels PAYÉS à l'API de recherche pour cette découverte
    const budget = Math.min(Math.max(Math.round(Number(b.budget)) || 60, 1), 500);
    // job boards des fonds + agrégateurs (gratuits, mais allongent la collecte) : actifs sauf demande contraire
    const extras = b.extras !== false;
    // recherche publique LinkedIn (sans compte) : uniquement sur demande
    const linkedin = b.linkedin === true;
    // sites d'entreprise visités pendant cette collecte (pages carrières lues par des sessions Claude Code)
    const sites = b.sites === true ? Math.min(Math.max(Math.round(Number(b.sites_limit)) || 150, 1), 3000) : 0;
    if (!startCollect({ discover, budget, extras, linkedin, sites })) return res.status(409).json({ error: "Une collecte est déjà en cours" });
    res.json({ ok: true });
  });

  app.get("/api/status", (_req, res) => res.json(jobStatus()));

  app.post("/api/stop", (_req, res) => res.json({ stopped: stopCollect() }));

  // --- Pages carrières suivies ---
  app.get("/api/boards", (_req, res) =>
    res.json(
      db
        .prepare(
          `SELECT b.ats, b.slug, b.company, b.last_fetched_at, b.last_count, b.last_error,
                  (SELECT COUNT(*) FROM jobs j WHERE j.ats = b.ats AND j.slug = b.slug AND j.closed_at IS NULL) AS open_jobs
           FROM boards b
           ORDER BY open_jobs DESC, b.slug`
        )
        .all()
    )
  );

  app.post("/api/boards", async (req, res) => {
    const refs = (req.body as Record<string, unknown> | undefined)?.refs;
    if (typeof refs !== "string" || !refs.trim()) {
      return res.status(400).json({ error: "Indiquez au moins un site d'entreprise, une URL de page carrières ou un couple ats:slug." });
    }
    res.json(await addBoardsFromText(refs));
  });

  // --- Offres ---
  app.get("/api/jobs", (req, res) => res.json(queryJobs(req.query as Record<string, unknown>)));

  // --- Entreprises à prospecter (tableau) : une ligne par entreprise, la plus récente offre d'abord ---
  app.get("/api/companies", (req, res) => res.json(queryCompanies(req.query as Record<string, unknown>)));

  // --- Export CSV des entreprises (mêmes filtres que /api/companies, ou keys=alan,qonto) ---
  app.get("/api/companies.csv", (req, res) => {
    const rows = queryCompanies(req.query as Record<string, unknown>);
    const headers = [
      "entreprise", "effectif", "offres_tech", "offre_la_plus_recente", "publiee_le", "url_offre",
      "prenom", "nom", "poste", "linkedin", "confiance", "prenom_2", "nom_2", "poste_2", "linkedin_2",
    ];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");
    const lines = rows.map((r) =>
      [
        r.company, r.headcount, r.company_open, r.title, day(r.posted_at ?? r.first_seen_at), r.url,
        r.contact_first_name, r.contact_last_name, r.contact_role, r.contact_linkedin, r.contact_confidence,
        r.contact2_first_name, r.contact2_last_name, r.contact2_role, r.contact2_linkedin,
      ]
        .map(cell)
        .join(";")
    );
    // BOM + point-virgule : ouverture directe dans Excel/Numbers FR
    const csv = "﻿" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="entreprises-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // --- Fiche d'une entreprise (clic sur son nom dans le tableau) ---
  app.get("/api/company", (req, res) => {
    const card = companyCard(String(req.query.key ?? ""));
    if (!card) return res.status(404).json({ error: "Entreprise inconnue" });
    res.json(card);
  });

  // --- Contact saisi à la main sur la fiche d'une entreprise (URL de son profil LinkedIn) ; second: true l'ajoute
  // comme second contact au lieu de remplacer le premier ---
  app.post("/api/contact", async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const key = String(b.key ?? "");
    const url = profileUrl(String(b.linkedin ?? ""));
    if (!url) return res.status(400).json({ error: "Collez l'URL d'un profil LinkedIn (linkedin.com/in/…)." });
    if (!db.prepare("SELECT 1 FROM jobs WHERE company_key = ?").get(key)) return res.status(404).json({ error: "Entreprise inconnue" });
    try {
      res.json(await addManualContact(key, url, b.second === true));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // --- Export CSV (mêmes filtres que /api/jobs, ou ids=1,2,3) ---
  app.get("/api/jobs.csv", (req, res) => {
    const rows = queryJobs(req.query as Record<string, unknown>);
    const headers = ["poste", "entreprise", "categorie", "service", "localisation", "teletravail", "publiee_le", "jours_en_ligne", "offres_tech_entreprise", "statut", "cabinet_esn", "source", "url"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const day = (t: number | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");
    const lines = rows.map((r) =>
      [
        r.title, r.company, r.category, r.department, r.location, r.remote ? "oui" : "",
        day(r.posted_at ?? r.first_seen_at), r.days_open, r.company_open, r.closed_at ? "fermée" : "en ligne", r.agency ? "oui" : "", r.ats, r.url,
      ]
        .map(cell)
        .join(";")
    );
    // BOM + point-virgule : ouverture directe dans Excel/Numbers FR
    const csv = "﻿" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="offres-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });
}
