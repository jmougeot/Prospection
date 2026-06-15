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

-- Cache de l'enrichissement entreprise (API publique Recherche d'Entreprises) :
-- une boîte rencontrée dans les résultats n'est résolue qu'une fois.
CREATE TABLE IF NOT EXISTS company_cache (
  name_key TEXT PRIMARY KEY,             -- nom normalisé (ou « siren:<siren> » pour un cache par SIREN)
  info TEXT NOT NULL,                    -- JSON CompanyInfo | null
  fetched_at INTEGER NOT NULL
);

-- Résolveur de noms d'entreprise : index « toute forme de nom → entité ».
CREATE TABLE IF NOT EXISTS company_alias (
  alias_norm  TEXT NOT NULL,             -- nom normalisé (clé de résolution)
  siren       TEXT,                      -- entité canonique
  effectif    TEXT,                      -- tranche INSEE (null si seed sans attributs)
  naf_section TEXT,                      -- section NAF (A..U)
  ca          INTEGER,                   -- dernier CA connu (€)
  source      TEXT,                      -- wikidata | annuaire | sirene | api
  UNIQUE (alias_norm, siren)
);
CREATE INDEX IF NOT EXISTS idx_company_alias_norm ON company_alias (alias_norm);

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
`);

// Migrations additives sur les bases existantes (no-op si déjà présentes)
function addColumnIfMissing(table: string, column: string, ddl: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumnIfMissing("prospects", "company_effectif", "company_effectif TEXT");
addColumnIfMissing("prospects", "company_section", "company_section TEXT");
addColumnIfMissing("prospects", "company_ca", "company_ca INTEGER");
