/**
 * Sème l'index de résolution `company_alias` depuis Wikidata (licence CC0).
 *
 * Cible : toutes les entités FR ayant un SIREN (P1616) ET un nom court / sigle
 * (P1813) — c'est là que le problème de nom est le pire (acronymes : « DGFiP »,
 * « CNRS », « RATP », « URSSAF », « INPI »…). Pour chacune, on indexe son
 * libellé, son sigle et tous ses alias FR → son SIREN. Les attributs
 * (effectif/secteur) restent nuls : resolveCompany les complète par SIREN, en
 * lookup exact, à la première résolution.
 *
 * Idempotent (INSERT OR IGNORE). Lancer : npx tsx scripts/seed-wikidata-aliases.ts
 */
import { db } from "../src/db.js";
import { nameKey } from "../src/services/b2b/company.js";

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "SequenceMail/0.1 (prospection B2B; +https://github.com/)";

const SPARQL = `
SELECT ?siren ?label ?short (GROUP_CONCAT(DISTINCT ?alt; separator="||") AS ?aliases) WHERE {
  ?item wdt:P1616 ?siren .
  ?item wdt:P1813 ?short .
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "fr") }
  OPTIONAL { ?item skos:altLabel ?alt . FILTER(LANG(?alt) = "fr") }
}
GROUP BY ?siren ?label ?short
`;

interface Binding {
  siren?: { value: string };
  label?: { value: string };
  short?: { value: string };
  aliases?: { value: string };
}

const put = db.prepare(
  "INSERT OR IGNORE INTO company_alias (alias_norm, siren, effectif, naf_section, ca, source) VALUES (?, ?, NULL, NULL, NULL, 'wikidata')"
);

async function main(): Promise<void> {
  console.log("Requête Wikidata (entités FR avec SIREN + sigle)…");
  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(SPARQL)}`;
  const res = await fetch(url, {
    headers: { accept: "application/sparql-results+json", "user-agent": UA },
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    console.error(`Wikidata a répondu ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = (await res.json()) as { results?: { bindings?: Binding[] } };
  const rows = data.results?.bindings ?? [];
  console.log(`${rows.length} entités reçues. Indexation des alias…`);

  let entities = 0;
  let aliases = 0;
  const seed = db.transaction((bindings: Binding[]) => {
    for (const b of bindings) {
      const siren = (b.siren?.value ?? "").replace(/\D/g, "");
      if (siren.length !== 9) continue; // SIREN = 9 chiffres
      const names = [b.label?.value, b.short?.value, ...(b.aliases?.value ? b.aliases.value.split("||") : [])];
      const keys = new Set<string>();
      for (const n of names) {
        const k = n ? nameKey(n) : "";
        if (k) keys.add(k);
      }
      for (const k of keys) {
        put.run(k, siren);
        aliases++;
      }
      if (keys.size) entities++;
    }
  });
  seed(rows);
  console.log(`Terminé : ${entities} entités, ${aliases} alias indexés dans company_alias.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
