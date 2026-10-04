/**
 * Test en direct des lecteurs de src/sources/ats-extra.ts :
 *   npx tsx scripts/test-ats-extra.ts [ats…]
 * Pour chaque ATS : lecture de quelques vraies pages carrières, décompte des offres
 * France + tech, échantillon, puis slug inconnu (BoardNotFound attendu). Rien n'est
 * écrit en base.
 */
import { BoardNotFound } from "../src/ats.js";
import { isInFrance, techCategory } from "../src/classify.js";
import { EXTRA_ATS_LIST, EXTRA_READERS, type ExtraAts, parseExtraBoardRef } from "../src/sources/ats-extra.js";

const SLUGS: Record<ExtraAts, string[]> = {
  teamtailor: ["payfit", "ornikar", "yousign"],
  recruitee: ["mpgpartners1", "aubay", "institutminestelecom"],
  personio: ["zvoove", "teliogroup"],
  breezy: ["abc-arbitrage", "actimage"],
  flatchr: ["cirilgroup", "evoliz", "ilemgroup"],
  taleez: ["gandi", "orsys", "webnet"],
  pinpoint: ["ravelin", "nccgroup"],
  join: ["unikandco", "revoludevfr"],
  bamboohr: ["jobandtalent", "lumapps"],
};
const UNKNOWN = "nope-xyz-123456";

const REFS: Array<[string, string | null]> = [
  ["https://wiremind-1714146283.teamtailor.com/jobs/8144754-software-engineer-h-f-cdi-paris", "teamtailor:wiremind-1714146283"],
  ["https://instantsystem.recruitee.com/o/developpeur-mobile-ios-swift-hf-biot", "recruitee:instantsystem"],
  ["https://pno-group-europe.jobs.personio.com/job/2461874?language=en", "personio:pno-group-europe"],
  ["zvoove.jobs.personio.de", "personio:zvoove"],
  ["https://gojob.breezy.hr/p/ad94a33f4490-charg-e--de-recrutement-h-f-cdi---paris", "breezy:gojob"],
  ["https://careers.flatchr.io/fr/company/evoliz/vacancy/adyjo9mkxxzdkr0r-lead-developpeur-web-fullstack/", "flatchr:evoliz"],
  ["https://cirilgroup.flatchr.io/en/company/cirilgroup/", "flatchr:cirilgroup"],
  ["https://careers.flatchr.io/vacancy/gyxmvp33y2kp8mzr-developpeur-full-stack-junior-h-f-cdi", null],
  ["https://gandi.taleez.com/", "taleez:gandi"],
  ["https://taleez.com/apply/data-engineer-paris-odysis-cdi", null],
  ["https://confluence.pinpointhq.com/en/postings/c7f0918f-6199-4611-be30-50084b7f5485", "pinpoint:confluence"],
  ["https://join.com/companies/baqio/16674765-developpeur-se-integrations", "join:baqio"],
  ["https://jobandtalent.bamboohr.com/careers/82", "bamboohr:jobandtalent"],
  ["https://www.bamboohr.com/careers/", null],
  ["teamtailor:careers.payfit.com", "teamtailor:careers.payfit.com"],
  ["Teamtailor: Payfit", "teamtailor:payfit"],
  ["https://www.teamtailor.com/en/", null],
  ["https://jobs.lever.co/ekimetrics/5df8aeca", null],
  ["lever:ekimetrics", null],
];

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.log(`  ✗ ${msg}`);
};

console.log("== parseExtraBoardRef");
for (const [input, expected] of REFS) {
  const ref = parseExtraBoardRef(input);
  const got = ref ? `${ref.ats}:${ref.slug}` : null;
  if (got === expected) console.log(`  ✓ ${input} → ${got}`);
  else fail(`${input} → ${got} (attendu : ${expected})`);
}

const only = process.argv.slice(2);
for (const ats of EXTRA_ATS_LIST) {
  if (only.length && !only.includes(ats)) continue;
  console.log(`\n== ${ats}`);
  for (const slug of SLUGS[ats]) {
    try {
      const postings = await EXTRA_READERS[ats](slug);
      const kept = postings.filter((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department));
      const withDesc = postings.filter((p) => p.description).length;
      const withDate = postings.filter((p) => p.posted_at).length;
      console.log(
        `  ${slug} : ${postings.length} offres, ${postings.filter((p) => isInFrance(p.location, p.country)).length} en France, ` +
          `${kept.length} France+tech — entreprise « ${postings[0]?.company ?? "?"} », ${withDesc} avec texte, ${withDate} datées`
      );
      for (const p of (kept.length ? kept : postings).slice(0, 3)) {
        const day = p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 10) : "sans date";
        console.log(
          `    - [${techCategory(p.title, p.department) ?? "-"}] ${p.title} | ${p.department ?? "-"} | ${p.location ?? "-"} (${p.country ?? "-"})` +
            `${p.remote ? " | remote" : ""} | ${day} | ${p.url}`
        );
      }
      if (!postings.length) console.log("    (aucune offre publiée en ce moment)");
    } catch (err) {
      fail(`${slug} : ${err instanceof BoardNotFound ? "BoardNotFound" : err instanceof Error ? err.message : err}`);
    }
  }
  try {
    const postings = await EXTRA_READERS[ats](UNKNOWN);
    fail(`${UNKNOWN} : ${postings.length} offres au lieu de BoardNotFound`);
  } catch (err) {
    if (err instanceof BoardNotFound) console.log(`  ✓ ${UNKNOWN} → BoardNotFound`);
    else fail(`${UNKNOWN} : ${err instanceof Error ? err.message : err} (BoardNotFound attendu)`);
  }
}

console.log(failures ? `\n${failures} échec(s)` : "\nTout est bon.");
process.exit(failures ? 1 : 0);
