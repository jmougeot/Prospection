/**
 * Texte d'une offre lu sur sa page, pour les sources qui ne donnent que l'intitulé
 * (page carrières d'un site d'entreprise, job board d'un fonds) :
 *  1. description du JSON-LD `JobPosting` ;
 *  2. à défaut, texte de la page, si elle est bien celle de l'offre (son titre
 *     reprend l'intitulé) — jamais celui d'une page commune à plusieurs offres.
 * Les pages d'offres de Welcome to the Jungle sont derrière un pare-feu
 * anti-robots : on ne les charge pas (voir wttj.ts). Ne lève jamais.
 */
import { htmlToText, parseJobPostings } from "./careers.js";
import { get, isPageOf } from "./job-date.js";

export interface JobText {
  text: string | null; // null : la page ne porte pas le texte de l'offre
  read: boolean; // false : page illisible (panne, anti-robot) — à retenter plus tard
}

const MAX_HTML = 3_000_000;
const MIN_TEXT = 400; // en deçà : page vide, rendue par script, ou simple renvoi vers un formulaire
const NEVER_LOADED = /(^|\.)welcometothejungle\.com$/i;

export async function fetchJobText(url: string, title: string): Promise<JobText> {
  let html: string;
  let pageUrl: string;
  try {
    if (NEVER_LOADED.test(new URL(url).hostname)) return { text: null, read: true };
    const res = await get(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    if (res.status === 404 || res.status === 410) return { text: null, read: true };
    // 202 : page d'attente d'un pare-feu anti-robots, pas celle de l'offre
    if (!res.ok || res.status === 202) return { text: null, read: false };
    if (!/html/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      return { text: null, read: true };
    }
    html = (await res.text()).slice(0, MAX_HTML);
    pageUrl = res.url || url;
  } catch {
    return { text: null, read: false };
  }
  const postings = parseJobPostings(html, pageUrl);
  const structured = postings.length === 1 ? postings[0].description : null;
  if (structured && structured.length >= MIN_TEXT) return { text: structured, read: true };
  if (!isPageOf(html, title)) return { text: null, read: true };
  // le contenu de la page, sans son habillage (menus, pied de page) quand il est balisé
  const content = (/<main\b[\s\S]*<\/main>/i.exec(html) ?? /<article\b[\s\S]*<\/article>/i.exec(html) ?? /<body\b[\s\S]*<\/body>/i.exec(html))?.[0] ?? html;
  const text = htmlToText(content.replace(/<(nav|header|footer|noscript|svg|form)\b[\s\S]*?<\/\1>/gi, " "));
  return { text: text && text.length >= MIN_TEXT ? text : null, read: true };
}
