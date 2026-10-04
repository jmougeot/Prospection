/**
 * Essai des agrégateurs (France Travail, Adzuna, Arbeitnow, DevITjobs, Free-Work) : `npx tsx scripts/test-aggregators.ts`
 * depuis Offres/. N'écrit rien en base. Pour chaque source : configurée ou non,
 * puis une petite collecte (peu d'appels) avec les compteurs utiles. Les sources
 * à clé sont aussi vérifiées hors ligne, sur un exemple au format documenté.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { type Posting } from "../src/ats.js";
import { isInFrance, techCategory } from "../src/classify.js";
import {
  AGGREGATORS,
  AggregatorNotConfigured,
  agencyReason,
  looksLikeAgency,
  mapAdzuna,
} from "../src/sources/aggregators.js";

const DAYS = Number(process.env.TEST_DAYS) || 7;
// Petit plafond par défaut : Adzuna ne donne que 250 appels par jour.
const MAX_REQUESTS = Number(process.env.TEST_MAX_REQUESTS) || 6;

function report(postings: Posting[]): void {
  const kept = postings.filter((p) => isInFrance(p.location, p.country) && techCategory(p.title, p.department));
  const agencies = kept.filter(looksLikeAgency);
  const companies = new Set(kept.map((p) => p.company).filter(Boolean));
  const dates = postings.map((p) => p.posted_at).filter((d): d is number => d !== null);
  console.log(`  offres reçues            : ${postings.length}`);
  console.log(`  France + tech            : ${kept.length}`);
  console.log(`  dont cabinet / ESN       : ${agencies.length}`);
  console.log(`  entreprises distinctes   : ${companies.size} (sans nom : ${kept.filter((p) => !p.company).length})`);
  if (dates.length) {
    const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
    console.log(`  dates de publication     : ${day(Math.min(...dates))} → ${day(Math.max(...dates))}`);
  }
  for (const p of kept.slice(0, 8)) {
    const reason = agencyReason(p);
    console.log(
      `   - [${techCategory(p.title, p.department)}] ${p.title} | ${p.company ?? "?"} | ${p.location ?? "?"}` +
        ` | ${p.posted_at ? new Date(p.posted_at).toISOString().slice(0, 10) : "?"}${reason ? ` | CABINET (${reason})` : ""}`
    );
    console.log(`     ${p.url}`);
  }
}

/** Contrôles sans réseau : mapping des formats documentés, heuristique cabinet, source non configurée. */
async function offline(): Promise<void> {
  const az = mapAdzuna({
    id: "4567890123",
    title: "<strong>Développeur</strong> Python H/F",
    description: "Au sein de l'équipe plateforme, vous développez nos services &amp; API…",
    created: "2026-10-02T14:03:11Z",
    redirect_url: "https://www.adzuna.fr/land/ad/4567890123?se=abc&utm_medium=api",
    company: { display_name: "Qonto" },
    location: { display_name: "Paris, Ile-de-France", area: ["France", "Ile-de-France", "Paris"] },
    category: { tag: "it-jobs", label: "Emplois Informatique" },
    contract_type: "permanent",
  });
  assert.equal(az.external_id, "4567890123");
  assert.equal(az.title, "Développeur Python H/F");
  assert.equal(az.company, "Qonto");
  assert.equal(az.description, "Au sein de l'équipe plateforme, vous développez nos services & API…");
  assert.equal(az.posted_at, Date.parse("2026-10-02T14:03:11Z"));
  assert.ok(isInFrance(az.location, az.country));
  assert.equal(techCategory(az.title, az.department), "dev");
  assert.equal(looksLikeAgency(az), false);

  const flag = (company: string | null, description: string | null): boolean => looksLikeAgency({ company, description });
  assert.ok(flag("Michael Page", null));
  assert.ok(flag("SII Ouest", null));
  assert.ok(flag("Dupont Conseil", null));
  assert.ok(flag(null, "Notre client, éditeur de logiciels, recrute…"));
  assert.ok(flag("Acme", "Vous interviendrez pour le compte d’un grand groupe bancaire."));
  assert.ok(flag("Acme", "We are hiring on behalf of our client, a leading fintech."));
  assert.equal(flag("Doctolib", "Nos clients sont des praticiens de santé."), false);
  assert.equal(flag("Mistral AI", "Join the inference team in Paris."), false);

  for (const source of AGGREGATORS) {
    if (source.configured()) continue;
    await assert.rejects(() => source.fetch({ maxRequests: 1 }), AggregatorNotConfigured, `${source.key} : sans clé, erreur explicite attendue`);
  }
  console.log("Contrôles hors ligne (formats documentés, heuristique cabinet, source non configurée) : OK\n");
}

await offline();

for (const source of AGGREGATORS) {
  const ok = source.configured();
  console.log(`${source.name} (${source.key}) — ${ok ? "configuré" : "NON configuré (variables absentes de .env)"}`);
  if (!ok) {
    console.log("");
    continue;
  }
  const started = Date.now();
  try {
    const postings = await source.fetch({ days: DAYS, maxRequests: MAX_REQUESTS });
    console.log(`  fenêtre ${DAYS} j, ${MAX_REQUESTS} appels au plus, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    report(postings);
  } catch (err) {
    console.log(`  ÉCHEC : ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log("");
}
