import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Relatif au projet (src/../data), pas au répertoire de lancement ; surchargeable via DATA_DIR
const DATA_DIR = process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "enrichissement.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
-- Personnes trouvées par poste au sein des entreprises cibles (via moteurs de
-- recherche). Le slug du profil sert d'identité : un même profil n'est jamais
-- inséré deux fois, quelles que soient les recherches qui le remontent.
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT,                             -- poste affiché sur le profil
  company TEXT,                          -- entreprise lue dans le résultat
  company_id INTEGER,                    -- lien vers companies.id (rempli en fin de recherche) ; null si non résolue
  company_domain TEXT,                   -- domaine probable de l'entreprise (modèle, non vérifié)
  company_headcount_est TEXT,            -- effectif mondial estimé (modèle, indicatif)
  company_revenue_est TEXT,              -- CA annuel estimé (modèle, indicatif)
  location TEXT,                         -- localisation lue dans le résultat
  linkedin TEXT NOT NULL,                -- URL du profil
  linkedin_key TEXT NOT NULL UNIQUE,     -- slug normalisé (dédoublonnage)
  email TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending', -- pending | verified | pattern | probable | not_found | no_domain
  search_role TEXT,                      -- poste saisi lors de la recherche
  search_id INTEGER,                     -- identifiant de la recherche (scope « recherche en cours »)
  company_effectif TEXT,                 -- tranche d'effectifs INSEE de l'entreprise (registre)
  company_section TEXT,                  -- section NAF de l'entreprise (registre)
  company_ca INTEGER,                    -- dernier CA connu de l'entreprise (€, registre)
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_prospects_search ON prospects (search_id);

-- Cache de l'extraction LLM (Haiku) : un même snippet n'est interprété qu'une
-- fois. Clé = hash du texte d'entrée ; valeur = JSON ExtractedPerson | null
-- (null mémorisé aussi, pour ne pas re-payer un texte non interprétable).
CREATE TABLE IF NOT EXISTS extract_cache (
  text_key TEXT PRIMARY KEY,             -- sha1 du texte (titre + snippet)
  person TEXT NOT NULL,                  -- JSON ExtractedPerson | null
  fetched_at INTEGER NOT NULL
);

-- Cache des pages de résultats de l'API de recherche : une page déjà payée ne
-- reconsomme jamais de crédit (les profils bougent peu d'un jour à l'autre).
CREATE TABLE IF NOT EXISTS search_cache (
  query TEXT NOT NULL,
  page INTEGER NOT NULL,
  results TEXT NOT NULL,                 -- JSON WebResult[]
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (query, page)
);

-- Une recherche (poste+entreprises+localisation+secteur) garde le même
-- identifiant d'un lancement à l'autre : ses prospects s'accumulent dans le même scope.
CREATE TABLE IF NOT EXISTS searches (
  key TEXT PRIMARY KEY,                  -- paramètres normalisés
  search_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

-- Base d'entreprises constituée à la main : on donne un nom, il est enrichi une
-- fois (registre Recherche d'Entreprises + détection du site) puis conservé.
-- Dédoublonnage par nom normalisé : ré-ajouter une entreprise complète ses infos.
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- nom saisi
  name_key TEXT NOT NULL UNIQUE,         -- nom normalisé (clé de dédoublonnage)
  siren TEXT,                            -- registre français
  effectif TEXT,                         -- dormant (ancien registre INSEE), conservé tel quel
  naf_section TEXT,                      -- dormant (ancienne section NAF), conservé tel quel
  ca INTEGER,                            -- dernier chiffre d'affaires connu (€)
  domain TEXT,                           -- site web (findDomain)
  -- Attributs importés de CSV LinkedIn (data/Company-final.csv), complémentaires
  -- du registre FR : on les conserve tels quels (l'industrie LinkedIn diffère du NAF).
  location TEXT,                         -- localisation (chaîne complète, ville en tête)
  headcount INTEGER,                     -- effectif déclaré LinkedIn (nombre)
  industry TEXT,                         -- secteur LinkedIn (libellé, distinct de naf_section)
  year_founded INTEGER,                  -- année de création
  company_type TEXT,                     -- type (Partnership, Privately Held…)
  added_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`);

// Migrations additives sur les bases existantes (no-op si déjà présentes)
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing("prospects", "company_id", "company_id INTEGER");
addColumnIfMissing("prospects", "company_domain", "company_domain TEXT");
addColumnIfMissing("prospects", "company_headcount_est", "company_headcount_est TEXT");
addColumnIfMissing("prospects", "company_revenue_est", "company_revenue_est TEXT");
addColumnIfMissing("prospects", "company_effectif", "company_effectif TEXT");
addColumnIfMissing("prospects", "company_section", "company_section TEXT");
addColumnIfMissing("prospects", "company_ca", "company_ca INTEGER");
addColumnIfMissing("companies", "location", "location TEXT");
addColumnIfMissing("companies", "headcount", "headcount INTEGER");
addColumnIfMissing("companies", "industry", "industry TEXT");
addColumnIfMissing("companies", "year_founded", "year_founded INTEGER");
addColumnIfMissing("companies", "company_type", "company_type TEXT");
