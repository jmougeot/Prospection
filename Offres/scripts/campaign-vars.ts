/**
 * Recalcule, depuis la base des offres, les variables de personnalisation des contacts d'une campagne Sequence-mail :
 *   offre        intitulé de l'offre à citer (src/pitch.ts)
 *   competences  ses deux ou trois exigences précises, « A, B et C » — absente si l'offre n'en cite pas
 *   personnalisation  le paragraphe rédigé pour cette offre (scripts/job-pitch.ts) — absent s'il n'y en a pas
 *   nb_offres    offres tech en ligne de l'entreprise
 *   accroche     « un profil « X » », ou « N profils tech, dont « X » »
 * Les offres ouvrent et ferment tous les jours : à relancer avant de lancer une campagne, après une collecte,
 * scripts/job-skills.ts et scripts/job-pitch.ts.
 *   npx tsx scripts/campaign-vars.ts <export.csv> [<export.csv> …]
 *
 * Entrée : l'export CSV des contacts d'une campagne (colonnes linkedin, email, company, offre, competences…).
 * Sortie : <export>-maj.csv à côté de chaque export, à réimporter dans LA MÊME campagne — l'import met à jour les
 * contacts déjà inscrits, sans rien envoyer. Un contact est rattaché à son entreprise par son profil LinkedIn
 * (tables contacts / second_contacts), à défaut par le nom de l'entreprise.
 * Un contact dont l'offre citée n'a plus de compétences ou de paragraphe reçoit « [vider] », que l'import de
 * Sequence-mail lit comme « retirer ce champ ». Les contacts dont l'entreprise n'a plus aucune offre à citer sont listés à part.
 */
import fs from "node:fs";
import { contactCompany, csvLine, parseCsv } from "../src/campaign.js";
import { citedOffer, joinSkills } from "../src/pitch.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage : npx tsx scripts/campaign-vars.ts <export.csv> [<export.csv> …]");
  process.exit(1);
}

for (const file of files) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const lines = ["linkedin,email,offre,accroche,nb_offres,competences,personnalisation"];
  const none: string[] = []; // entreprise sans offre à citer
  let cleared = 0; // compétences d'une offre qui n'est plus celle citée, ou qui n'en a plus : retirées
  let changed = 0;
  let skilled = 0;
  let pitched = 0;
  for (const r of rows) {
    const who = `${[r.first_name, r.last_name].filter(Boolean).join(" ")} (${r.company})`;
    const offer = citedOffer(contactCompany(r.linkedin, r.company));
    if (!offer) {
      none.push(who);
      continue;
    }
    const accroche = offer.offers === 1 ? `un profil « ${offer.title} »` : `${offer.offers} profils tech, dont « ${offer.title} »`;
    const competences = joinSkills(offer.skills);
    if (competences) skilled++;
    else if (r.competences) cleared++;
    const pitch = offer.pitch ?? "";
    if (pitch) pitched++;
    if (r.offre !== offer.title || r.accroche !== accroche || r.nb_offres !== String(offer.offers) || (r.competences ?? "") !== competences || (r.personnalisation ?? "") !== pitch) changed++;
    // une cellule vide laisserait l'ancienne valeur : CLEAR_FIELD de Sequence-mail la retire
    const orClear = (value: string, current: string | undefined): string => value || (current ? "[vider]" : "");
    lines.push(csvLine([r.linkedin ?? "", r.email ?? "", offer.title, accroche, offer.offers, orClear(competences, r.competences), orClear(pitch, r.personnalisation)]));
  }
  const out = file.replace(/\.csv$/i, "") + "-maj.csv";
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${file} : ${rows.length} contact(s), ${lines.length - 1} avec une offre à citer (${pitched} avec paragraphe, ${skilled} avec compétences, ${cleared} qui les perdent), ${changed} à mettre à jour → ${out}`);
  if (none.length) console.log(`  entreprise sans offre à citer : ${none.join(" ; ")}`);
}
