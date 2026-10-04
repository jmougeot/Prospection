/**
 * Point d'entrée unique sur les pages carrières : les cinq ATS d'origine
 * (ats.ts) et les ATS supplémentaires retenus (sources/ats-extra.ts).
 */
import { type Ats, ATS_LIST, type Posting, fetchBoard, parseBoardRef } from "./ats.js";
import { EXTRA_READERS, parseExtraBoardRef } from "./sources/ats-extra.js";

// Pinpoint et BambooHR existent dans ats-extra.ts mais ne sont pas branchés :
// aucune entreprise tech française trouvée dessus lors des essais.
const EXTRA_ATS = ["teamtailor", "recruitee", "flatchr", "taleez", "breezy", "personio", "join"] as const;
type ExtraAts = (typeof EXTRA_ATS)[number];

export type BoardAts = Ats | ExtraAts;
export interface BoardRef {
  ats: BoardAts;
  slug: string;
}

const isAts = (ats: string): ats is Ats => (ATS_LIST as readonly string[]).includes(ats);
const isExtra = (ats: string): ats is ExtraAts => (EXTRA_ATS as readonly string[]).includes(ats);

export function isBoardAts(ats: string): ats is BoardAts {
  return isAts(ats) || isExtra(ats);
}

/** Toutes les offres publiées d'une entreprise. Lève BoardNotFound si le slug n'existe pas. */
export function readBoard(ats: BoardAts, slug: string): Promise<Posting[]> {
  return isAts(ats) ? fetchBoard(ats, slug) : EXTRA_READERS[ats](slug);
}

/** URL d'offre / de page carrières ou « ats:slug » → page carrières, tous ATS confondus. */
export function parseAnyBoardRef(input: string): BoardRef | null {
  const ref = parseBoardRef(input) ?? parseExtraBoardRef(input);
  return ref && isBoardAts(ref.ats) ? { ats: ref.ats, slug: ref.slug } : null;
}
