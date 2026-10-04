/**
 * Importe des signalements d'entreprises (fichier JSON { "<signalement>": ["Nom", …] }) dans company_flags :
 * école, conseil_ou_cabinet, pas_une_entreprise.   npx tsx scripts/import-flags.ts <fichier.json>
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { companyKey } from "../src/company.js";

db.exec("CREATE TABLE IF NOT EXISTS company_flags (company_key TEXT PRIMARY KEY, flag TEXT NOT NULL)");
const put = db.prepare("INSERT OR REPLACE INTO company_flags (company_key, flag) VALUES (?, ?)");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8")) as Record<string, string[]>;
let n = 0;
db.transaction(() => {
  for (const [flag, names] of Object.entries(data)) for (const name of names) if (companyKey(name)) n += put.run(companyKey(name), flag).changes;
})();
console.log(`${n} signalement(s) importé(s)`);
