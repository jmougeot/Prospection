# Déploiement sur le CX33 partagé (à côté de la stack « ruby »)

Le serveur fait déjà tourner la stack `ruby` avec **`ruby-caddy`** qui détient 80/443 et
route par domaine sur le réseau `ruby_default`. On réutilise ce Caddy comme proxy unique
et on n'ajoute que le conteneur **app** de Sequence Mail (SQLite, pas de Postgres).

Sous-domaine cible : **go.rubysignal.com**

---

## 0. DNS (une fois)

```
Type A    Nom: go    Valeur: <IP_DU_CX33>    Proxy: désactivé (DNS only)
```
Vérifier : `dig +short go.rubysignal.com` → IP du CX33.

## 1. Copier le projet sur le serveur

```bash
# depuis le Mac
rsync -av --exclude node_modules --exclude data --exclude _tmpdata \
  ~/Desktop/Ruby/prospection/Sequence-mail/ root@<IP>:/opt/sequence-mail/
```

## 2. Créer le .env de prod

```bash
ssh root@<IP>
cd /opt/sequence-mail
cp .env.example .env && nano .env
```
Au minimum :
```dotenv
BASE_URL=https://go.rubysignal.com
VISIT_BASE_URL=https://go.rubysignal.com
VISIT_DEST_URL=https://www.rubysignal.com
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
# + SERPER_API_KEY, ATTIO_*, quotas…
```

## 3. Lancer SEULEMENT l'app (réseau ruby_default, sans Caddy bundlé)

```bash
cd /opt/sequence-mail
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml logs -f app   # vérifier le démarrage
```
Le conteneur s'appelle `sequence-app` et rejoint `ruby_default`.
Vérifier qu'il est bien sur le réseau :
```bash
docker network inspect ruby_default --format '{{range .Containers}}{{.Name}} {{end}}'
# doit lister … sequence-app
```

## 4. Générer le mot de passe du dashboard

```bash
docker run --rm caddy:2 caddy hash-password --plaintext 'CHOISIS_UN_MOT_DE_PASSE'
```

## 5. Ajouter le bloc au Caddyfile de ruby-caddy

Éditer `/opt/ruby/docker/Caddyfile` et coller le contenu de `caddy-snippet.txt`
(à la fin), en remplaçant `REMPLACE_PAR_LE_HASH_BCRYPT` par le hash de l'étape 4.

Recharger Caddy **sans interrompre la stack ruby** :
```bash
docker exec ruby-caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```
> Si le Caddyfile est monté en read-only, l'édition se fait sur l'hôte
> (`/opt/ruby/docker/Caddyfile`) puis on recharge — le fichier monté reflète le changement.

Caddy obtient le certificat Let's Encrypt en ~30 s. Ouvrir https://go.rubysignal.com
→ login `admin` + mot de passe → dashboard.

## 6. Google OAuth

console.cloud.google.com → client OAuth « Web » → URI de redirection autorisé :
```
https://go.rubysignal.com/auth/google/callback
```
Puis reconnecter les comptes Google depuis le dashboard.

---

## Importer une base locale existante (optionnel)

```bash
# Mac
scp ~/Desktop/Ruby/prospection/Sequence-mail/data/sequence-mail.db root@<IP>:/opt/sequence-mail/seed.db
# Serveur
cd /opt/sequence-mail
docker compose -f docker-compose.server.yml stop app
docker run --rm -v sequence-mail_sequence-data:/data -v /opt/sequence-mail:/src \
  busybox cp /src/seed.db /data/sequence-mail.db
docker compose -f docker-compose.server.yml start app
```

## Mises à jour

```bash
rsync -av --exclude node_modules --exclude data --exclude _tmpdata \
  ~/Desktop/Ruby/prospection/Sequence-mail/ root@<IP>:/opt/sequence-mail/
ssh root@<IP> 'cd /opt/sequence-mail && docker compose -f docker-compose.server.yml up -d --build'
```

## Sauvegardes

```bash
docker run --rm -v sequence-mail_sequence-data:/data -v /opt/sequence-mail/backups:/b \
  busybox cp /data/sequence-mail.db /b/backup-$(date +%F).db
```
(À programmer en cron.)
