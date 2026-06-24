/**
 * Retire de data/2000-AE.csv les leads dont l'entreprise est « trop grosse »
 * (> 1000 salariés au niveau mondial). La taille réelle de ces boîtes n'est pas
 * dans le registre FR (qui ne connaît que la petite filiale française) : on
 * filtre donc sur une liste noire éditable, data/big-companies.txt.
 *
 *   npx tsx scripts/filter-big-companies.ts
 *
 * Écrit data/2000-AE-PME.csv (lignes conservées). L'original n'est pas modifié.
 * Affiche le détail de ce qui est retiré pour pouvoir ajuster la liste noire.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "data", "2000-AE.csv");
const OUT = join(root, "data", "2000-AE-PME.csv");
const BLACKLIST = join(root, "data", "big-companies.txt");

/** Minuscule, sans accents ni emoji/ponctuation : ne reste que des mots [a-z0-9]. */
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Liste noire → un test « le terme apparaît-il en mots entiers ? » par entreprise.
const terms = readFileSync(BLACKLIST, "utf8")
  .split("\n")
  .map((l) => l.replace(/#.*/, "").trim())
  .filter(Boolean)
  .map((t) => ({ label: t, re: new RegExp(`\\b${norm(t).replace(/ /g, "\\s+")}\\b`) }));

function matchedTerm(entreprise: string): string | null {
  const n = norm(entreprise);
  if (!n) return null;
  for (const t of terms) if (t.re.test(n)) return t.label;
  return null;
}

const lines = readFileSync(SRC, "utf8").split("\n");
const header = lines[0];
const kept: string[] = [header];
const removed: Array<{ entreprise: string; by: string }> = [];

for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const entreprise = line.split(";")[3] ?? "";
  const hit = matchedTerm(entreprise);
  if (hit) removed.push({ entreprise, by: hit });
  else kept.push(line);
}

writeFileSync(OUT, kept.join("\n") + "\n");

// Récap : combien retiré, et par quel terme (pour repérer les faux positifs).
const byTerm = new Map<string, string[]>();
for (const r of removed) {
  const arr = byTerm.get(r.by) ?? [];
  arr.push(r.entreprise);
  byTerm.set(r.by, arr);
}
console.log(`Total leads      : ${lines.length - 2}`);
console.log(`Retirés (> 1000) : ${removed.length}`);
console.log(`Conservés        : ${kept.length - 1}  ->  ${OUT}\n`);
console.log("Retirés par terme de la liste noire :");
for (const [term, hits] of [...byTerm.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${String(hits.length).padStart(3)}  ${term}`);
}
