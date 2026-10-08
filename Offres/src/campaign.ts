/**
 * Lecture des exports de campagne de Sequence-mail et rattachement de leurs contacts aux entreprises de la base
 * (scripts/campaign-vars.ts, scripts/campaign-emails.ts).
 */
import { companyKey } from "./company.js";
import { db } from "./db.js";

/** CSV (séparateur , ou ; détecté sur la ligne d'en-têtes) → un objet par ligne, clés en minuscules. */
export function parseCsv(text: string): Array<Record<string, string>> {
  const s = text.replace(/^﻿/, "");
  const head = s.split(/\r?\n/, 1)[0] ?? "";
  const sep = (head.match(/;/g) ?? []).length > (head.match(/,/g) ?? []).length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [names, ...lines] = rows;
  return lines.map((r) => Object.fromEntries((names ?? []).map((n, i) => [n.trim().toLowerCase(), r[i] ?? ""])));
}

/** Ligne de CSV, toutes cellules entre guillemets. */
export const csvLine = (cells: Array<string | number>): string => cells.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",");

/** Identifiant d'un profil LinkedIn, quels que soient le sous-domaine pays et l'encodage de l'URL. */
export function profile(url: string | null | undefined): string | null {
  const m = (url ?? "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]).toLowerCase();
  } catch {
    return m[1].toLowerCase();
  }
}

// profil LinkedIn → entreprise(s) dont il est le contact
let companiesOf: Map<string, Set<string>> | null = null;

/**
 * Entreprise (company_key) d'un contact de campagne : celle dont il est le contact dans la base et qui porte ce nom ;
 * à défaut la seule dont il l'est ; à défaut celle que désigne le nom.
 */
export function contactCompany(linkedin: string | null | undefined, company: string | null | undefined): string {
  if (!companiesOf) {
    companiesOf = new Map();
    for (const table of ["contacts", "second_contacts"]) {
      for (const r of db.prepare(`SELECT company_key, linkedin FROM ${table} WHERE linkedin IS NOT NULL`).all() as Array<{ company_key: string; linkedin: string }>) {
        const id = profile(r.linkedin);
        if (!id) continue;
        if (!companiesOf.has(id)) companiesOf.set(id, new Set());
        companiesOf.get(id)!.add(r.company_key);
      }
    }
  }
  const named = companyKey(company ?? "");
  const keys = companiesOf.get(profile(linkedin) ?? "") ?? new Set<string>();
  return keys.has(named) ? named : keys.size === 1 ? [...keys][0] : named;
}
