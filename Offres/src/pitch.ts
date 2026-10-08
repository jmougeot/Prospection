/**
 * Offre à citer dans un message de prospection — « j'ai vu que vous recrutez un <poste> et que vous cherchez
 * <compétences> » — et ordre dans lequel les offres d'une entreprise sont lues pour la trouver
 * (scripts/job-skills.ts).
 */
import { cleanTitle, isLeadership, isTrainee, techCategory } from "./classify.js";
import { db, SINCE } from "./db.js";

db.function("is_trainee", { deterministic: true }, (title) => (isTrainee(String(title ?? "")) ? 1 : 0));
db.function("is_leadership", { deterministic: true }, (title) => (isLeadership(String(title ?? "")) ? 1 : 0));
// le tri des postes tech est refait à la lecture : une règle corrigée dans classify.ts vaut aussi pour les offres déjà collectées
db.function("is_tech", { deterministic: true }, (title, department) =>
  techCategory(String(title ?? ""), department === null ? null : String(department)) ? 1 : 0
);

/** Offres qu'on peut citer : postes tech en ligne, hors stages, alternances, thèses et VIE. */
export const CITABLE = (t = ""): string => `${t}closed_at IS NULL AND NOT is_trainee(${t}title) AND is_tech(${t}title, ${t}department)`;
/** Ordre de préférence : un poste d'ingénieur avant un poste d'encadrement, puis l'offre en ligne depuis le plus longtemps. */
export const CITE_ORDER = (t = ""): string => `is_leadership(${t}title), ${SINCE(t)}, ${t}id`;
/** L'offre a des compétences à citer ; `PRECISE` : autre chose qu'une liste de langages généralistes. */
export const HAS_SKILLS = (t = ""): string => `(${t}skills IS NOT NULL AND ${t}skills <> '[]')`;
export const PRECISE = (t = ""): string => `(${HAS_SKILLS(t)} AND ${t}skills_generic = 0)`;
/** L'offre citée d'une entreprise est la première dans cet ordre : exigences précises, à défaut langages, à défaut rien. */
export const CITED_FIRST = (t = ""): string => `NOT ${PRECISE(t)}, NOT ${HAS_SKILLS(t)}, ${CITE_ORDER(t)}`;

export interface CitedOffer {
  id: number;
  title: string; // intitulé tel qu'on le dit dans une phrase
  skills: string[]; // deux ou trois exigences de l'offre, mot pour mot ; aucune si elle n'en cite pas d'exploitable
  generic: boolean; // ces exigences ne sont que des langages généralistes, cités en dernier recours
  url: string;
  offers: number; // offres citables de l'entreprise (« 4 profils tech, dont … »)
  pitch: string | null; // paragraphe de personnalisation rédigé pour cette offre (null : pas rédigé, ou rien de précis à en dire)
}


const cited = db.prepare(
  `SELECT id, title AS raw, short_title, skills, skills_generic, pitch, url, COUNT(*) OVER () AS offers FROM jobs
   WHERE company_key = ? AND ${CITABLE()}
   ORDER BY ${CITED_FIRST()} LIMIT 1`
);

/**
 * Offre à citer pour une entreprise : la première, dans l'ordre de préférence, qui formule des exigences précises ; à
 * défaut la première dont on a relevé des langages ; à défaut la première tout court, nommée sans compétences. Null si
 * l'entreprise n'a aucune offre citable.
 */
export function citedOffer(companyKey: string): CitedOffer | null {
  const row = cited.get(companyKey) as
    | { id: number; raw: string; short_title: string | null; skills: string | null; skills_generic: number; pitch: string | null; url: string; offers: number }
    | undefined;
  if (!row) return null;
  return {
    id: row.id, title: row.short_title ?? cleanTitle(row.raw), skills: row.skills ? (JSON.parse(row.skills) as string[]) : [], generic: row.skills_generic === 1,
    url: row.url, offers: row.offers,
    pitch: row.pitch || null,
  };
}

/** Compétences en une énumération : « Python, BigQuery et SQLMesh ». */
export function joinSkills(skills: string[]): string {
  return skills.length > 1 ? `${skills.slice(0, -1).join(", ")} et ${skills[skills.length - 1]}` : (skills[0] ?? "");
}
