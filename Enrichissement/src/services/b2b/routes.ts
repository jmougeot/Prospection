/**
 * Routes de la prospection : recherche de personnes par poste (LinkedIn) au sein
 * d'entreprises ciblées (liste fournie OU sélection dans la base enrichie par
 * headcount/industry), suivi du job, tableau des prospects et exports.
 */
import type express from "express";
import { db } from "../../db.js";
import { type CompanyRow, type CompanyListFilters, listCompanies } from "./companies.js";
import { currentSearchId, jobStatus, startProspecting, stopProspecting } from "./enrich.js";
import { hasSearchApi } from "./search.js";

/** « a, b ; c » → ["a","b","c"] (séparateurs virgule/point-virgule). */
function splitList(v: unknown): string[] {
  return typeof v === "string" ? v.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : [];
}

/** Liste de boîtes saisie dans un textarea : une par ligne (ou « ; »). */
function splitLines(v: unknown): string[] {
  return typeof v === "string" ? v.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean) : [];
}

/** Secteurs (industry LinkedIn) distincts de la base, pour peupler le filtre. */
function distinctIndustries(): string[] {
  return (
    db
      .prepare("SELECT DISTINCT industry FROM companies WHERE industry IS NOT NULL AND TRIM(industry) <> '' ORDER BY industry")
      .all() as Array<{ industry: string }>
  ).map((r) => r.industry);
}

export function registerB2bRoutes(app: express.Express): void {
  app.get("/api/b2b/meta", (_req, res) => res.json({ search_api: hasSearchApi(), industries: distinctIndustries() }));

  // --- Recherche de personnes (job en tâche de fond) ---
  app.post("/api/b2b/prospect", (req, res) => {
    const b = req.body as Record<string, unknown>;
    const s = (k: string) => (typeof b[k] === "string" && (b[k] as string).trim() ? (b[k] as string).trim() : undefined);
    const cont = Boolean(b.continue);
    const roles = splitList(b.poste); // un ou plusieurs postes (séparés par virgule)
    const companies = splitLines(b.entreprises); // boîtes cibles, une par ligne
    // La recherche exige une API de recherche (Serper/Google/Brave) — plus de scraping.
    if (!hasSearchApi()) {
      return res.status(400).json({ error: "Configurez une clé d'API de recherche (SERPER_API_KEY) dans .env." });
    }
    if (!cont && !roles.length) {
      return res.status(400).json({ error: "Indiquez au moins un poste recherché (ex. directeur commercial)" });
    }
    const target = Math.min(Math.max(Math.round(Number(b.target)) || 50, 5), 1000);
    // Zone ciblée : « fr » (défaut, rétro-compat), « us » ou « intl » (mondial).
    const region: "fr" | "us" | "intl" = b.region === "us" ? "us" : b.region === "intl" ? "intl" : "fr";
    const params = {
      roles,
      companies,
      exclude: splitList(b.exclure),
      location: s("localisation"),
      sector: s("secteur"),
      region,
    };
    // Sélection des entreprises déjà enrichies : effectif LinkedIn + secteur.
    const company: CompanyListFilters = {
      headcountMin: b.headcount_min ? Number(b.headcount_min) : undefined,
      headcountMax: b.headcount_max ? Number(b.headcount_max) : undefined,
      industry: s("industry"),
    };
    const hasCompanyFilter = company.headcountMin != null || company.headcountMax != null || Boolean(company.industry);
    // recherche TOUJOURS par boîte : il faut une source — liste fournie OU filtre base enrichie
    if (!cont && !companies.length && !hasCompanyFilter) {
      return res.status(400).json({
        error: "Indiquez des entreprises (une par ligne) ou un filtre headcount/industry pour cibler des boîtes enrichies.",
      });
    }
    if (!startProspecting(params, company, target, cont)) {
      return res.status(409).json({ error: "Une recherche est déjà en cours" });
    }
    res.json({ ok: true });
  });

  app.get("/api/b2b/status", (_req, res) => res.json(jobStatus()));

  // --- Arrêt du job en cours ---
  app.post("/api/b2b/stop", (_req, res) => res.json({ stopped: stopProspecting() }));

  // --- Prospects ---
  interface ProspectRow {
    id: number;
    first_name: string;
    last_name: string;
    role: string | null;
    company: string | null;
    company_id: number | null;
    company_domain: string | null;
    company_headcount_est: string | null;
    company_revenue_est: string | null;
    location: string | null;
    linkedin: string;
    search_role: string | null;
  }

  function queryProspects(query: Record<string, unknown>): ProspectRow[] {
    const conds: string[] = [];
    const params: unknown[] = [];
    // Filtre géographique à la lecture : on enregistre TOUS les prospects, mais on
    // ne montre que ceux de la zone demandée (?region=fr|us|intl, défaut « fr »).
    //  - fr  : profils fr.linkedin.com (membres en France) ;
    //  - us  : profils sans sous-domaine pays (www/linkedin.com — les membres US
    //          n'ont pas de sous-domaine dédié), en écartant les sous-domaines
    //          pays étrangers (fr., de., uk.…) ;
    //  - intl: aucun filtre (mondial).
    // (?region=intl remplace l'ancien ?france=0 ; le sous-domaine reste un signal
    // bien plus fiable qu'une heuristique de lieu — cf. enrich.ts keepProspects.)
    const region = query.region === "us" ? "us" : query.region === "intl" ? "intl" : "fr";
    if (region === "fr") {
      conds.push("linkedin LIKE '%//fr.linkedin.com/%'");
    } else if (region === "us") {
      conds.push("(linkedin LIKE '%//www.linkedin.com/%' OR linkedin LIKE '%//linkedin.com/%')");
    }
    if (query.scope === "search") {
      const sid = currentSearchId();
      if (!sid) return [];
      conds.push("search_id = ?");
      params.push(sid);
    }
    if (query.ids) {
      const ids = String(query.ids).split(",").map(Number).filter(Number.isFinite);
      if (ids.length) {
        conds.push(`id IN (${ids.map(() => "?").join(",")})`);
        params.push(...ids);
      }
    }
    if (query.role) {
      // plusieurs mots-clés possibles, séparés par des virgules (ex. directeur,ceo)
      const keywords = String(query.role).split(",").map((s) => s.trim()).filter(Boolean);
      if (keywords.length) {
        conds.push(`(${keywords.map(() => "role LIKE ?").join(" OR ")})`);
        params.push(...keywords.map((k) => `%${k}%`));
      }
    }
    if (query.q) {
      conds.push("(first_name LIKE ? OR last_name LIKE ? OR company LIKE ? OR location LIKE ?)");
      const like = `%${String(query.q)}%`;
      params.push(like, like, like, like);
    }
    return db
      .prepare(
        `SELECT id, first_name, last_name, role, company, company_id, company_domain, company_headcount_est, company_revenue_est,
                location, linkedin, search_role
         FROM prospects
         ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
         ORDER BY id DESC
         LIMIT 5000`
      )
      .all(...params) as ProspectRow[];
  }

  app.get("/api/b2b/prospects", (req, res) => res.json(queryProspects(req.query as Record<string, unknown>)));

  // --- Export CSV (mêmes filtres que /api/b2b/prospects, ou ids=1,2,3) ---
  app.get("/api/b2b/prospects.csv", (req, res) => {
    const rows = queryProspects(req.query as Record<string, unknown>);
    const headers = ["prenom", "nom", "poste", "entreprise", "domaine", "effectif_estime", "ca_estime", "localisation", "linkedin"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.first_name, r.last_name, r.role, r.company, r.company_domain, r.company_headcount_est, r.company_revenue_est, r.location, r.linkedin]
        .map(cell)
        .join(";")
    );
    // BOM + point-virgule : ouverture directe dans Excel/Numbers FR
    const csv = "﻿" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });

  // --- Base d'entreprises (table companies) ---
  function queryCompanies(query: Record<string, unknown>): CompanyRow[] {
    return listCompanies({
      q: typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined,
      headcountMin: query.headcount_min ? Number(query.headcount_min) : undefined,
      headcountMax: query.headcount_max ? Number(query.headcount_max) : undefined,
      industry: typeof query.industry === "string" && query.industry.trim() ? query.industry.trim() : undefined,
    });
  }

  app.get("/api/b2b/companies", (req, res) => res.json(queryCompanies(req.query as Record<string, unknown>)));

  app.get("/api/b2b/companies.csv", (req, res) => {
    const rows = queryCompanies(req.query as Record<string, unknown>);
    const headers = ["nom", "domaine", "industry", "headcount", "annee_creation", "type", "localisation"];
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = rows.map((r) =>
      [r.name, r.domain, r.industry, r.headcount ?? "", r.year_founded ?? "", r.company_type, r.location].map(cell).join(";")
    );
    const csv = "﻿" + [headers.join(";"), ...lines].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="entreprises-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  });
}
