/**
 * Effectif des entreprises qui ont des offres en base, pour cibler par taille :
 *  - Welcome to the Jungle (effectif déclaré sur la fiche entreprise) ;
 *  - base Enrichissement (effectif LinkedIn), lue seule.
 * Écrit la table `company_sizes` de offres.db.   npx tsx scripts/company-sizes.ts
 */
import Database from "better-sqlite3";
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { companyKey } from "../src/company.js";

db.exec("CREATE TABLE IF NOT EXISTS company_sizes (company_key TEXT PRIMARY KEY, headcount INTEGER NOT NULL, source TEXT NOT NULL)");
const put = db.prepare("INSERT OR REPLACE INTO company_sizes (company_key, headcount, source) VALUES (?, ?, ?)");
const sizes = new Map<string, { n: number; source: string }>();

const SITE = "https://www.welcometothejungle.com";
const env = await (await fetch(`${SITE}/api/env`)).text();
const read = (name: string): string => new RegExp(`"?${name}"?\\s*:\\s*"([^"]+)"`).exec(env)?.[1] ?? "";
const appId = read("PUBLIC_ALGOLIA_APPLICATION_ID");
const apiKey = read("PUBLIC_ALGOLIA_API_KEY_CLIENT");
let requests = 1;
async function range(from: number, to: number): Promise<void> {
  await new Promise((r) => setTimeout(r, 500));
  requests++;
  const res = await fetch(`https://${appId.toLowerCase()}-dsn.algolia.net/1/indexes/wttj_jobs_production_fr/query`, {
    method: "POST",
    headers: { "X-Algolia-Application-Id": appId, "X-Algolia-API-Key": apiKey, "content-type": "application/json", Referer: `${SITE}/`, Origin: SITE },
    body: JSON.stringify({
      query: "", hitsPerPage: 1000, attributesToHighlight: [],
      filters: "offices.country_code:FR AND new_profession.category_reference:tech-engineering-3NjUy",
      numericFilters: [`published_at_timestamp>=${from}`, `published_at_timestamp<${to}`],
      attributesToRetrieve: ["organization.name", "organization.nb_employees"],
    }),
  });
  if (!res.ok) throw new Error(`WTTJ HTTP ${res.status}`);
  const data = (await res.json()) as { nbHits: number; hits: Array<{ organization?: { name?: string; nb_employees?: number } }> };
  if (data.nbHits > 1000 && to - from > 86400) {
    const mid = Math.floor((from + to) / 2);
    await range(mid, to);
    await range(from, mid);
    return;
  }
  for (const h of data.hits) {
    const n = h.organization?.nb_employees;
    if (h.organization?.name && typeof n === "number" && n > 0) sizes.set(companyKey(h.organization.name), { n, source: "wttj" });
  }
}
const now = Math.floor(Date.now() / 1000) + 86400;
await range(now - 110 * 86400, now);
const fromWttj = sizes.size;

const source = new Database(config.enrichissementDb, { readonly: true, fileMustExist: true });
for (const r of source.prepare("SELECT name, headcount FROM companies WHERE headcount > 0").all() as Array<{ name: string; headcount: number }>) {
  const key = companyKey(r.name);
  if (key && !sizes.has(key)) sizes.set(key, { n: r.headcount, source: "enrichissement" });
}
source.close();

db.transaction(() => sizes.forEach((v, k) => put.run(k, v.n, v.source)))();
console.log(`${requests} requêtes WTTJ · ${fromWttj} effectifs WTTJ · ${sizes.size - fromWttj} effectifs Enrichissement`);
