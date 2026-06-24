/**
 * Amorce la base d'entreprises (table `companies`) à partir d'un CSV exporté de
 * LinkedIn (data/Company-final.csv par défaut). Import PUR DB, sans réseau :
 * Name → name, Website → domain, et Location/Headcounts/Industry/Year Founded/
 * Type conservés tels quels. Dédoublonné par nom normalisé (name_key) : relancer
 * le script complète les champs manquants sans créer de doublon (idempotent).
 *
 *   npx tsx scripts/seed-companies.ts [chemin.csv]
 *
 * On n'importe que les champs présents dans le CSV (nom, domaine, effectif
 * déclaré, secteur, localisation…). Aucun appel réseau.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedCompanies } from "../src/services/b2b/companies.js";
import { db } from "../src/db.js";
import { parseCsv } from "./csv.js";

const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

/** Index d'une colonne par nom (tolérant aux espaces/casse de l'en-tête). */
function col(header: string[], name: string): number {
  return header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
}

/** Parse un entier (chiffres seulement) ou null. */
function toInt(v: string | undefined): number | null {
  const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function clean(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  return s || null;
}

function main(): void {
  const input = process.argv[2] ? path.resolve(process.argv[2]) : path.join(DATA_DIR, "Company-final.csv");
  const records = parseCsv(fs.readFileSync(input, "utf8"));
  if (!records.length) throw new Error("CSV vide");
  const header = records[0];
  const iName = col(header, "Name");
  if (iName < 0) throw new Error(`Colonne « Name » introuvable : ${header.join(" | ")}`);
  const iLoc = col(header, "Location");
  const iHead = col(header, "Headcounts");
  const iInd = col(header, "Industry");
  const iYear = col(header, "Year Founded");
  const iType = col(header, "Type");
  const iSite = col(header, "Website");

  const rows = records
    .slice(1)
    .filter((r) => r.length > iName && r[iName].trim())
    .map((r) => ({
      name: r[iName].trim(),
      location: iLoc >= 0 ? clean(r[iLoc]) : null,
      headcount: iHead >= 0 ? toInt(r[iHead]) : null,
      industry: iInd >= 0 ? clean(r[iInd]) : null,
      year_founded: iYear >= 0 ? toInt(r[iYear]) : null,
      company_type: iType >= 0 ? clean(r[iType]) : null,
      domain: iSite >= 0 ? clean(r[iSite]) : null,
    }));

  const before = (db.prepare("SELECT count(*) AS n FROM companies").get() as { n: number }).n;
  console.error(`Import de ${rows.length} ligne(s) depuis ${path.basename(input)}…`);
  const upserted = seedCompanies(rows);
  const after = (db.prepare("SELECT count(*) AS n FROM companies").get() as { n: number }).n;

  const added = after - before;
  console.log(`✓ ${upserted} ligne(s) traitée(s) · ${added} nouvelle(s) · ${upserted - added} complétée(s)/dédoublonnée(s)`);
  console.log(`  Base : ${after} entreprise(s) au total.`);
  process.exit(0);
}

try {
  main();
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
