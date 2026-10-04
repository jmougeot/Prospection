# Prospection

Monorepo regroupant les outils de prospection / cold outreach. Trois sous-projets
indépendants (chacun son `package.json`, sa base SQLite, son app desktop) :

## `Enrichissement/` — moteur de prospection B2B
Recherche de personnes par poste **au sein d'entreprises cibles** (liste fournie
ou énumération du registre par taille/secteur), via les moteurs de recherche
(Serper en priorité). Résolveur de noms d'entreprise (index d'alias + Wikidata),
recherche d'emails optionnelle, export CSV.
- Port **3100** · `cd Enrichissement && npm install && npm start`
- App desktop : `npm run desktop:app`

## `Sequence-mail/` — séquenceur d'emails
Campagnes multi-comptes Google Workspace : séquences, suivi des réponses,
répartition de charge, protection de la délivrabilité (warm-up, bounces, OOO),
synchro Attio.
- Port **3000** · `cd Sequence-mail && npm install && npm start`
- App desktop : `npm run desktop:app`

## `Offres/` — collecte d'offres d'emploi tech
Offres **dev, data / ML et devops en France**, lues sur les pages carrières
publiques des ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Workable).
Découverte de nouvelles entreprises via Serper, suivi de l'ancienneté et de la
fermeture des offres, export CSV.
- Port **3200** · `cd Offres && npm install && npm start`

Les trois peuvent tourner en parallèle (ports distincts). Il n'y a **pas de pont
automatique** entre eux pour l'instant : l'export de prospects vers une campagne
se fait par CSV.

## Notes
- Chaque sous-projet a son `.env` (clés API) — **non versionné**.
- Les bases de données (`*/data/*.db`) sont locales et **non versionnées**.
- `.archive/` contient une sauvegarde de l'ancien historique git du mailer.
