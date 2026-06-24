/**
 * Nettoie/complète les domaines de TOUTE la base d'entreprises :
 *  1. supprime le bruit (noms de plus de 3 mots sans domaine — taglines captées) ;
 *  2. pour chaque entreprise restante sans domaine, cherche son site (findDomain :
 *     devine nom.com/.fr + vérifie la home, repli DuckDuckGo) ;
 *  3. si aucun domaine n'est trouvé, SUPPRIME l'entreprise (mauvais signe).
 *
 *   npx tsx scripts/clean-company-domains.ts
 *
 * Destructif : faites une copie de data/enrichissement.db avant si besoin.
 */
import { db } from "../src/db.js";
import { maintainCompanyBase } from "../src/services/b2b/enrich.js";

async function main(): Promise<void> {
  const before = (db.prepare("SELECT count(*) c FROM companies").get() as { c: number }).c;
  const missing = (db.prepare("SELECT count(*) c FROM companies WHERE domain IS NULL OR domain=''").get() as { c: number }).c;
  console.log(`Base : ${before} entreprises, ${missing} sans domaine.\n`);

  const { noise, found, deleted } = await maintainCompanyBase((done, total) => {
    if (done % 20 === 0 || done === total) {
      process.stdout.write(`\r${done}/${total} traitées`.padEnd(40));
    }
  });

  const after = (db.prepare("SELECT count(*) c FROM companies").get() as { c: number }).c;
  console.log(`\n\nBruit supprimé (>3 mots sans domaine) : ${noise}`);
  console.log(`Domaines trouvés                      : ${found}`);
  console.log(`Supprimées (domaine introuvable)      : ${deleted}`);
  console.log(`\nBase : ${before} → ${after} entreprises.`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
