/**
 * Sites d'entreprise suivis : pour une entreprise sans ATS lisible, on relit sa
 * page carrières à chaque passage. La liste part de la base d'entreprises
 * d'Enrichissement (lue seule, jamais modifiée) et des sites ajoutés à la main.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "./config.js";
import { db } from "./db.js";

export interface SiteRow {
  domain: string;
  company: string;
  page_hash: string | null;
}

const insertSite = db.prepare("INSERT OR IGNORE INTO sites (domain, company) VALUES (?, ?)");

/** Ajoute un site à suivre ; false s'il l'était déjà. */
export function addSite(domain: string, company: string): boolean {
  return insertSite.run(domain.toLowerCase(), company).changes > 0;
}

// Éditeurs de logiciels et entreprises tech de taille startup / scale-up.
const SEED_SQL = `
  SELECT name, domain FROM companies
  WHERE domain IS NOT NULL AND TRIM(domain) <> ''
    AND industry IN ('Software Development', 'Technology, Information and Internet')
    AND headcount BETWEEN 10 AND 2000`;

/** Importe les entreprises tech de la base Enrichissement (si elle existe). Renvoie le nombre de sites ajoutés. */
export function seedSites(): number {
  if (!fs.existsSync(config.enrichissementDb)) return 0;
  const source = new Database(config.enrichissementDb, { readonly: true, fileMustExist: true });
  try {
    const rows = source.prepare(SEED_SQL).all() as Array<{ name: string; domain: string }>;
    let added = 0;
    db.transaction(() => {
      for (const r of rows) {
        const domain = r.domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
        if (/^[\w-]+(\.[\w-]+)+$/.test(domain) && addSite(domain, r.name.trim())) added++;
      }
    })();
    return added;
  } finally {
    source.close();
  }
}

/** Les sites à (re)visiter : jamais vus d'abord, puis les plus anciennement vus. */
export function nextSites(limit: number): SiteRow[] {
  return db
    .prepare("SELECT domain, company, page_hash FROM sites ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT ?")
    .all(limit) as SiteRow[];
}

const update = db.prepare(
  "UPDATE sites SET careers_url = ?, status = ?, page_hash = ?, last_count = ?, last_checked_at = ? WHERE domain = ?"
);

// status : ats (offres lues via la page carrières de l'ATS) | jobs (offres lues sur le site)
//          | empty (page carrières sans poste) | none (pas de page carrières) | error
export function saveSite(
  domain: string,
  s: { careersUrl: string | null; status: "ats" | "jobs" | "empty" | "none" | "error"; pageHash?: string | null; count?: number }
): void {
  update.run(s.careersUrl, s.status, s.pageHash ?? null, s.count ?? 0, Date.now(), domain);
}

const TEXT_MAX = 9000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Texte lisible d'une page carrières, liens conservés entre crochets après leur
 * libellé (« Développeur Python [https://…] ») pour que le modèle puisse
 * rattacher chaque poste à son URL. Null si la page est illisible ou vide
 * (rendue par JavaScript, bloquée…).
 */
export async function careersText(url: string): Promise<{ text: string; hash: string } | null> {
  let html: string;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    html = await res.text();
  } catch {
    return null;
  }
  const text = html
    .replace(/<(script|style|svg|noscript|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      try {
        return ` ${label} [${new URL(href, url).href}] `;
      } catch {
        return ` ${label} `;
      }
    })
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;|&apos;/g, "'")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  if (text.length < 200) return null;
  // l'empreinte ignore les liens : ils portent souvent des jetons qui changent à chaque visite
  const hash = crypto.createHash("sha1").update(text.replace(/\[[^\]]*\]/g, "")).digest("hex");
  return { text: text.slice(0, TEXT_MAX), hash };
}
