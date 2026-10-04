/**
 * Importe des effectifs estimés (fichier JSON { "Nom d'entreprise": effectif }) dans company_sizes,
 * sans écraser un effectif déjà connu par WTTJ ou Enrichissement.
 *   npx tsx scripts/import-sizes.ts <fichier.json> <source>
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { companyKey } from "../src/company.js";

const [file, source] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, number | null>;
const put = db.prepare("INSERT OR IGNORE INTO company_sizes (company_key, headcount, source) VALUES (?, ?, ?)");
let added = 0;
db.transaction(() => {
  for (const [name, n] of Object.entries(data)) {
    if (typeof n === "number" && n > 0 && companyKey(name)) added += put.run(companyKey(name), Math.round(n), source).changes;
  }
})();
console.log(`${added} effectif(s) ajouté(s) (source : ${source})`);
