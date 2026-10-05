/**
 * Contact ajouté à la main sur la fiche d'une entreprise, à partir de la seule
 * URL de son profil LinkedIn. Le nom et le poste sont lus dans le résultat de
 * recherche du profil (une requête Serper) ; sans clé de recherche, ou si le
 * profil n'est pas indexé, le nom est déduit de l'URL.
 */
import { config } from "./config.js";
import { db } from "./db.js";

export interface ManualContact {
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  linkedin: string;
}

/** URL de profil LinkedIn sans paramètres ni barre finale, ou null si ce n'en est pas une. */
export function profileUrl(input: string): string | null {
  const m = input.trim().match(/^(?:https?:\/\/)?((?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^/?#\s]+)/i);
  return m ? `https://${m[1]}` : null;
}

const slugOf = (url: string): string => decodeURIComponent(url.split("/in/")[1] ?? "").toLowerCase();

/** « Jean Dupont - CTO chez Alma | LinkedIn » → nom et poste, d'après le résultat de recherche du profil. */
async function searchProfile(url: string): Promise<{ name: string; role: string | null } | null> {
  if (!config.serperApiKey) return null;
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "X-API-KEY": config.serperApiKey, "content-type": "application/json" },
      body: JSON.stringify({ q: `site:linkedin.com/in/${url.split("/in/")[1]}`, num: 5, gl: "fr", hl: "fr" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { organic?: Array<{ link: string; title?: string }> };
    const hit = (data.organic ?? []).find((r) => slugOf(r.link.split(/[?#]/)[0].replace(/\/$/, "")) === slugOf(url));
    if (!hit?.title) return null;
    const [name, ...rest] = hit.title.replace(/\s*[|·]\s*LinkedIn\s*$/i, "").split(/\s+[-–—]\s+/);
    return name.trim() ? { name: name.trim(), role: rest.join(" - ").trim() || null } : null;
  } catch {
    return null;
  }
}

/** « jean-dupont-1a2b3c » → « Jean Dupont » : l'identifiant final ajouté par LinkedIn est écarté. */
function nameFromSlug(url: string): string {
  const parts = slugOf(url).split("-").filter(Boolean);
  if (parts.length > 1 && /\d/.test(parts[parts.length - 1])) parts.pop();
  return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

const putInto = (table: "contacts" | "second_contacts") =>
  db.prepare(
    `INSERT OR REPLACE INTO ${table} (company_key, first_name, last_name, role, linkedin, confidence, reason, found_at)
     VALUES (?, ?, ?, ?, ?, 'haute', 'Ajouté à la main', ?)`
  );
const put = putInto("contacts");
const putSecond = putInto("second_contacts");

/**
 * Enregistre ce profil comme contact de l'entreprise, à la place de celui trouvé automatiquement s'il y en a un ;
 * avec `second`, comme second contact, à côté du premier.
 */
export async function addManualContact(companyKey: string, url: string, second = false): Promise<ManualContact> {
  const found = await searchProfile(url);
  const [first, ...last] = (found?.name ?? nameFromSlug(url)).split(/\s+/);
  const contact = { first_name: first || null, last_name: last.join(" ") || null, role: found?.role ?? null, linkedin: url };
  (second ? putSecond : put).run(companyKey, contact.first_name, contact.last_name, contact.role, url, Date.now());
  return contact;
}
