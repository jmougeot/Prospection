/**
 * Routes de la collecte d'offres : lancement / suivi du job, pages carrières
 * suivies, tableau des offres et export CSV.
 */
import type express from "express";
import { db } from "./db.js";
import { addBoardsFromText, jobStatus, startCollect, stopCollect } from "./collect.js";
import { hasSearchApi } from "./discover.js";

const DAY = 24 * 60 * 60 * 1000;

interface JobRow {
  id: number;
  ats: string;
  title: string;
  company: string;
  category: string;
  department: string | null;
  location: string | null;
  remote: number;
  url: string;
  posted_at: number | null;
  first_seen_at: number;
  closed_at: number | null;
  agency: number; // 1 = annonce probablement publiée par un cabinet ou une ESN
  company_open: number; // offres tech France en ligne dans la même entreprise
  days_open: number; // jours en ligne (jusqu'à la fermeture si l'offre est fermée)
}

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
  // ?hide_agency=1 : écarte les annonces signalées comme cabinet / ESN
  if (query.hide_agency === "1") conds.push("j.agency = 0");
  if (query.ids) {
    const ids = String(query.ids).split(",").map(Number).filter(Number.isFinite);
    if (ids.length) {
      conds.push(`j.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
  }
  const now = Date.now();
  const minDays = Math.max(0, Number(query.min_days) || 0);
  const minOpen = Math.max(0, Number(query.min_open) || 0);
  const rows = db
    .prepare(
      `SELECT j.id, j.ats, j.title, j.company, j.category, j.department, j.location, j.remote, j.url,
              j.posted_at, j.first_seen_at, j.closed_at, j.agency,
              (SELECT COUNT(*) FROM jobs o WHERE o.company_key = j.company_key AND o.closed_at IS NULL) AS company_open
       FROM jobs j
       ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
       ORDER BY COALESCE(j.posted_at, j.first_seen_at) DESC
       LIMIT 5000`
    )
    .all(...params) as Array<Omit<JobRow, "days_open">>;
  return rows
    .map((r) => ({
      ...r,
      days_open: Math.max(0, Math.floor(((r.closed_at ?? now) - (r.posted_at ?? r.first_seen_at)) / DAY)),
    }))
    .filter((r) => r.days_open >= minDays && r.company_open >= minOpen);
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
