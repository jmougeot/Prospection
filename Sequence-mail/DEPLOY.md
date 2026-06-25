# Déploiement sur un petit VPS (24/7)

> ⚠️ **La prod actuelle (`go.rubysignal.com`) n'utilise PAS ce guide.** Elle tourne
> sur le CX33 **partagé** avec la stack `ruby` : l'app rejoint `ruby-caddy` via le
> réseau `ruby_default`, **sans Caddy bundlé**, et se déploie avec
> `docker compose -f docker-compose.server.yml up -d --build`. Pour mettre à jour ou
> redéployer la prod, suis **`DEPLOY-SHARED.md`**, pas ce fichier.
>
> Ce guide-ci décrit une installation **autonome** (VPS dédié, Caddy bundlé via
> `docker-compose.yml`). N'y lance jamais le `docker compose up` nu sur le serveur
> partagé : il démarrerait un 2e Caddy (conflit port 80) et détacherait l'app de
> `ruby_default`, coupant le site.

Objectif : faire tourner Sequence Mail en continu sur un VPS, accessible en HTTPS
sur `go.rubysignal.com`. Le VPS devient la **source unique** : le dashboard, l'envoi
des séquences ET le suivi (ouvertures, clics, visites `{{link}}`) y tournent en
permanence — tes emails partent même Mac éteint.

Le suivi est public (`/p/`, `/t/`) ; le reste (dashboard, API, connexion Google) est
protégé par mot de passe (Caddy basic auth).

---

## 1. Créer le VPS

N'importe quel petit VPS Ubuntu 24.04 suffit (~4 €/mois) :
- **Hetzner** CX22 (le moins cher), **DigitalOcean**, **Scaleway**, **OVH**…
- 1 vCPU / 2 Go RAM = large.

Note l'**adresse IP publique** du VPS.

## 2. DNS : pointer le sous-domaine vers le VPS

Chez ton registrar / Cloudflare, crée un enregistrement :

```
Type A    Nom: go    Valeur: <IP_DU_VPS>    Proxy: désactivé (DNS only)
```

> Si tu utilises Cloudflare, mets le nuage en **gris** (DNS only) pour que Caddy
> puisse obtenir le certificat Let's Encrypt directement. Tu pourras réactiver le
> proxy ensuite si tu veux.

Vérifie : `dig +short go.rubysignal.com` doit renvoyer l'IP du VPS.

## 3. Installer Docker sur le VPS

```bash
ssh root@<IP_DU_VPS>
curl -fsSL https://get.docker.com | sh
```

## 4. Copier le projet sur le VPS

Depuis ton Mac (sans node_modules ni data) :

```bash
rsync -av --exclude node_modules --exclude data --exclude _tmpdata --exclude .env \
  ~/Desktop/Ruby/prospection/Sequence-mail/ root@<IP_DU_VPS>:/opt/sequence-mail/
```

## 5. Créer le `.env` sur le VPS

```bash
ssh root@<IP_DU_VPS>
cd /opt/sequence-mail
cp .env.example .env
nano .env
```

Renseigne au minimum :

```dotenv
BASE_URL=https://go.rubysignal.com
VISIT_BASE_URL=https://go.rubysignal.com
VISIT_DEST_URL=https://www.rubysignal.com

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# + tes clés habituelles (SERPER_API_KEY, ATTIO_*, quotas…)
```

## 6. Protéger le dashboard par mot de passe

Génère un hash puis colle-le dans le `Caddyfile` (remplace `REMPLACE_PAR_LE_HASH_BCRYPT`) :

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'CHOISIS_UN_MOT_DE_PASSE'
nano Caddyfile   # colle le hash après "admin "
```

## 7. (Optionnel) Récupérer tes campagnes existantes

Si tu veux garder les campagnes/contacts/comptes déjà créés en local, copie ta base
dans le volume Docker **avant** le premier démarrage :

```bash
# depuis ton Mac
scp ~/Desktop/Ruby/prospection/Sequence-mail/data/sequence-mail.db \
  root@<IP_DU_VPS>:/opt/sequence-mail/seed.db
```
```bash
# sur le VPS, une fois les volumes créés (après un premier `up`), voir l'étape 9.
```
(Si tu pars d'une base vierge, ignore cette étape.)

## 8. Lancer

```bash
cd /opt/sequence-mail
docker compose up -d --build
docker compose logs -f app   # vérifier le démarrage
```

Caddy obtient le certificat en ~30 s. Ouvre `https://go.rubysignal.com` → le
navigateur demande identifiant (`admin`) + ton mot de passe → le dashboard s'affiche.

## 9. Mettre à jour l'autorisation Google OAuth

Dans **console.cloud.google.com → Identifiants → ton client OAuth « Web »**, ajoute
l'URI de redirection autorisé :

```
https://go.rubysignal.com/auth/google/callback
```

Puis depuis le dashboard, reconnecte tes comptes Google (« + Connecter un compte »).

---

## Mettre à jour l'app plus tard

> Rappel : sur la prod partagée, c'est `DEPLOY-SHARED.md` qu'il faut suivre (compose
> `docker-compose.server.yml`). Les commandes ci-dessous valent pour l'install **autonome**.

```bash
# Mac : renvoyer le code (--exclude .env pour ne PAS écraser le .env de prod)
rsync -av --exclude node_modules --exclude data --exclude _tmpdata --exclude .env \
  ~/Desktop/Ruby/prospection/Sequence-mail/ root@<IP_DU_VPS>:/opt/sequence-mail/
# VPS : rebuild
cd /opt/sequence-mail && docker compose up -d --build
```

## Importer une base existante dans le volume (détail de l'étape 7)

```bash
# sur le VPS, app arrêtée
docker compose stop app
# copier seed.db dans le volume nommé
docker run --rm -v sequence-mail_sequence-data:/data -v /opt/sequence-mail:/src \
  busybox cp /src/seed.db /data/sequence-mail.db
docker compose start app
```

## Sauvegardes

La base vit dans le volume `sequence-mail_sequence-data`. Pour un dump régulier :

```bash
docker run --rm -v sequence-mail_sequence-data:/data -v /opt/sequence-mail/backups:/b \
  busybox cp /data/sequence-mail.db /b/backup-$(date +%F).db
```
(programme-le avec `cron` côté VPS.)
