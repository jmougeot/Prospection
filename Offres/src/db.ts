import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { companyKey } from "./company.js";

// Relatif au projet (src/../data), pas au répertoire de lancement ; surchargeable via DATA_DIR
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "offres.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
-- Pages carrières suivies : une entreprise sur un ATS (Greenhouse, Lever…),
-- identifiée par son slug. Alimentée par la découverte (API de recherche) ou à
-- la main ; relue à chaque collecte.
CREATE TABLE IF NOT EXISTS boards (
  ats TEXT NOT NULL,                     -- greenhouse | lever | ashby | smartrecruiters | workable
  slug TEXT NOT NULL,                    -- identifiant de l'entreprise chez l'ATS
  company TEXT,                          -- nom affiché (donné par l'ATS, sinon déduit du slug)
  last_fetched_at INTEGER,               -- dernière lecture réussie
  last_count INTEGER,                    -- offres tech France retenues à la dernière lecture
  last_error TEXT,                       -- dernière erreur de lecture (null si OK)
  added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (ats, slug)
);

-- Offres d'emploi tech en France. Une offre garde sa ligne d'une collecte à
-- l'autre : first_seen_at / last_seen_at / closed_at donnent son ancienneté
-- (signal d'urgence) et sa disparition.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ats TEXT NOT NULL,
  slug TEXT NOT NULL,
  external_id TEXT NOT NULL,             -- identifiant de l'offre chez l'ATS
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  category TEXT NOT NULL,                -- dev | data_ml | devops
  department TEXT,
  location TEXT,
  remote INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  description TEXT,                      -- texte brut tronqué (null si l'ATS ne le donne pas en liste)
  posted_at INTEGER,                     -- date de publication annoncée par la source, sinon trouvée sur la page de l'offre
  first_seen_at INTEGER NOT NULL,        -- première collecte où l'offre est apparue
  last_seen_at INTEGER NOT NULL,         -- dernière collecte où elle était en ligne
  closed_at INTEGER,                     -- collecte où elle a disparu (null = en ligne)
  UNIQUE (ats, slug, external_id)
);

-- Sites d'entreprise déjà visités à la recherche d'une page carrières : on ne
-- repasse pas sur un site à chaque collecte.
CREATE TABLE IF NOT EXISTS probed_domains (
  domain TEXT PRIMARY KEY,
  probed_at INTEGER NOT NULL,
  boards INTEGER NOT NULL                -- pages carrières reconnues sur ce site
);

CREATE INDEX IF NOT EXISTS idx_jobs_board ON jobs (ats, slug, closed_at);

-- Sites d'entreprise suivis : leur page carrières est relue à chaque passage
-- quand l'entreprise n'a pas d'ATS lisible.
CREATE TABLE IF NOT EXISTS sites (
  domain TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  careers_url TEXT,                      -- page carrières trouvée (null si aucune)
  status TEXT,                           -- ats | jobs | empty | none | error (null = jamais visité)
  page_hash TEXT,                        -- empreinte du texte de la page : inchangée = pas de relecture par le modèle
  last_count INTEGER,                    -- offres tech France retenues à la dernière visite
  last_checked_at INTEGER,
  added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Cache des pages de résultats de l'API de recherche : une page déjà payée ne
-- reconsomme jamais de crédit.
CREATE TABLE IF NOT EXISTS search_cache (
  query TEXT NOT NULL,
  page INTEGER NOT NULL,
  urls TEXT NOT NULL,                    -- JSON string[]
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (query, page)
);

-- Pages d'offre lues à la recherche de leurs dates (offres dont la source ne
-- donne pas de date de publication) : les dates suivent l'offre si elle est
-- réenregistrée, et la page est relue de temps en temps pour sa date de modification.
CREATE TABLE IF NOT EXISTS job_dates (
  url TEXT PRIMARY KEY,
  posted_at INTEGER,                     -- null : la page ne donne pas de date fiable
  modified_at INTEGER,                   -- dernière modification de la page (null si inconnue)
  checked_at INTEGER NOT NULL
);

-- Taille, signalements et nature des entreprises (remplis par les scripts de scripts/)
CREATE TABLE IF NOT EXISTS company_sizes (company_key TEXT PRIMARY KEY, headcount INTEGER NOT NULL, source TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS company_flags (company_key TEXT PRIMARY KEY, flag TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS company_types (company_key TEXT PRIMARY KEY, type TEXT NOT NULL, reason TEXT);

-- Décideur tech à contacter par entreprise (rempli par scripts/find-contacts.ts)
CREATE TABLE IF NOT EXISTS contacts (
  company_key TEXT PRIMARY KEY,
  first_name TEXT, last_name TEXT, role TEXT, linkedin TEXT,
  confidence TEXT NOT NULL,              -- haute | moyenne | faible | aucune (personne trouvée)
  reason TEXT,
  found_at INTEGER NOT NULL
);

-- Second contact d'une entreprise, gardé à côté du premier (par exemple son dirigeant en plus du décideur tech)
CREATE TABLE IF NOT EXISTS second_contacts (
  company_key TEXT PRIMARY KEY,
  first_name TEXT, last_name TEXT, role TEXT, linkedin TEXT,
  confidence TEXT NOT NULL,              -- haute | moyenne | faible
  reason TEXT,
  found_at INTEGER NOT NULL
);
`);

// Migrations additives sur les bases existantes (no-op si déjà présentes)
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// entreprise normalisée : rapproche une même boîte vue par plusieurs sources
addColumnIfMissing("jobs", "company_key", "company_key TEXT");
// annonce probablement publiée par un cabinet ou une ESN (sources agrégées uniquement)
addColumnIfMissing("jobs", "agency", "agency INTEGER NOT NULL DEFAULT 0");
// dernière modification de la page de l'offre, quand elle a été lue (voir job_dates)
addColumnIfMissing("jobs", "modified_at", "modified_at INTEGER");
db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs (company_key, closed_at)");
// offres enregistrées avant l'ajout de company_key
{
  const rows = db.prepare("SELECT id, company FROM jobs WHERE company_key IS NULL").all() as Array<{ id: number; company: string }>;
  const set = db.prepare("UPDATE jobs SET company_key = ? WHERE id = ?");
  db.transaction(() => rows.forEach((r) => set.run(companyKey(r.company), r.id)))();
}
