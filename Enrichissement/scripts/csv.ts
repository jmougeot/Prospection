/**
 * Parseur CSV minimal mais correct, partagé par les scripts (seed-companies,
 * find-websites). Gère les champs entre guillemets contenant le délimiteur, des
 * retours à la ligne et des guillemets échappés ("") : nécessaire car certaines
 * colonnes (ex. « Specialities ») contiennent des « ; » et des sauts de ligne,
 * donc une entreprise s'étale parfois sur plusieurs lignes physiques.
 */
export function parseCsv(text: string, delim = ";"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') {
      quoted = true;
    } else if (c === delim) {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Ré-échappe une cellule pour l'écriture CSV (quote si « ; », guillemet ou saut de ligne). */
export const csvCell = (v: string): string => (/[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
