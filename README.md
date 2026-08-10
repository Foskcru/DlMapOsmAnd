# DlMapOsmAnd — Cartes OsmAnd

Application web pour **récupérer, lister et rechercher** toutes les cartes
disponibles sur [`download.osmand.net/list.php`](https://download.osmand.net/list.php).

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![deps](https://img.shields.io/badge/d%C3%A9pendances-0-blue)

## Fonctionnalités

- 🗺️ **Carte du monde interactive** : les pays ayant une carte sont colorés ;
  survol pour voir le nombre de cartes, **clic sur un pays** pour **zoomer et
  afficher ses régions** (états/provinces). Les régions ayant une carte OsmAnd
  sont colorées et **cliquables pour télécharger** ; la liste des régions du
  pays s'affiche toujours en dessous (utile quand le découpage OsmAnd diffère
  du découpage administratif, ex. les grandes régions françaises)
- 🔎 **Barre de recherche** instantanée (pays, région, description…)
- 🗂️ **Filtres** par **pays**, par type (carte, courbes de niveau, Wikipédia,
  voix…) et par continent
- ↕️ **Tri** par nom, taille ou date
- ⬇️ **Lien de téléchargement direct** pour chaque carte
- ⚡ **Zéro dépendance runtime** : Node.js natif (`http`/`https`) ; Leaflet et le
  fond de carte GeoJSON sont **embarqués** dans le projet (aucun CDN requis)
- 🧠 **Cache serveur** (1 h) pour ne pas surcharger les serveurs OsmAnd

### Mode démonstration (hors ligne)

Pour prévisualiser l'interface sans accès à `download.osmand.net` (données
factices) :

```bash
MOCK_MAPS=1 node server.js
```

## Pourquoi un petit serveur ?

`list.php` ne renvoie pas d'en-têtes CORS. Un `fetch` lancé directement depuis
le navigateur serait donc bloqué. Le serveur Node fait office de **proxy** :
il récupère la page de `list.php` (tableau HTML), la transforme en JSON propre,
et sert le frontend statique. Aucun service tiers n'est nécessaire.

## Prérequis

- [Node.js](https://nodejs.org) **≥ 18** (aucun `npm install` requis)

## Démarrage

```bash
# depuis la racine du projet
npm start
# ou directement :
node server.js
```

Puis ouvrez **http://localhost:3000**

Pour changer le port :

```bash
PORT=8080 node server.js
```

## Tester depuis un téléphone (GitHub Codespaces)

Sans rien installer, avec ton compte GitHub :

1. Sur le téléphone, ouvre le dépôt sur **github.com** (branche `main`).
2. Bouton vert **Code** → onglet **Codespaces** → **Create codespace**.
3. Attends le démarrage. Grâce au fichier `.devcontainer/devcontainer.json`,
   le serveur se lance tout seul et le port **3000** est ouvert
   automatiquement.
4. Un lien vers l'application s'affiche (onglet **Ports** si besoin) : ouvre-le
   dans le navigateur du téléphone.

> Astuce : dans l'onglet **Ports**, tu peux passer le port en « Public » si tu
> veux partager le lien.

## Déploiement Docker (ex. sur un NAS)

Le projet inclut un `Dockerfile` et un `docker-compose.yml`. Aucune
dépendance à installer : l'image reste très légère.

### Avec docker compose (recommandé)

```bash
docker compose up -d --build
```

Puis ouvrez **http://IP-DU-NAS:3000**

Pour arrêter :

```bash
docker compose down
```

### Sans compose

```bash
docker build -t dlmaposmand .
docker run -d --name dlmaposmand -p 3000:3000 --restart unless-stopped dlmaposmand
```

### Image Docker prête à l'emploi (GHCR)

Une **GitHub Action** ([`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml))
reconstruit et publie l'image sur GHCR à chaque commit :
`ghcr.io/foskcru/dlmaposmand:latest`.

Dans **Dockge / Portainer / docker compose**, colle cette configuration
([`compose.image.yaml`](compose.image.yaml)) :

```yaml
services:
  dlmaposmand:
    image: ghcr.io/foskcru/dlmaposmand:latest
    container_name: dlmaposmand
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
```

Puis démarre et ouvre **http://IP-DU-SERVEUR:3000** (change `3000:3000`
en `AUTRE-PORT:3000` si le port est pris).

- **Prérequis (une seule fois)** : le *package* GHCR doit être **public** —
  GitHub → avatar → **Your packages** → `dlmaposmand` → **Package settings** →
  **Danger Zone** → **Change visibility** → **Public**.
  *(Alternative : `docker login ghcr.io` avec un token `read:packages`.)*
- **Mettre à jour** : `docker pull ghcr.io/foskcru/dlmaposmand:latest` puis
  recrée le conteneur (ou le bouton *pull/update* de Dockge, ou **Watchtower**
  pour une mise à jour automatique).

### Mise à jour automatique depuis GitHub (sans copier de fichiers) — le plus simple

Le fichier [`compose.autoupdate.yaml`](compose.autoupdate.yaml) fournit une
variante qui **clone la dernière version de `main` au démarrage**. C'est la
méthode la plus simple pour n'importe qui (Dockge, Portainer…) : colle son
contenu dans un nouveau stack, puis **Start**. Pour mettre à jour, un simple
**Restart** suffit (aucun fichier à transférer, aucun registre).

```yaml
services:
  dlmaposmand:
    image: node:20-alpine
    container_name: dlmaposmand
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
    command: >
      sh -c "apk add --no-cache git &&
             rm -rf /srv/app &&
             git clone --depth 1 https://github.com/Foskcru/DlMapOsmAnd.git /srv/app &&
             cd /srv/app && node server.js"
```

### Notes NAS (Synology / QNAP / TrueNAS…)

- Si le port **3000** est déjà utilisé, changez la partie gauche du mapping
  dans `docker-compose.yml` (ex. `"8096:3000"`) puis ouvrez le NAS sur ce port.
- Le conteneur a besoin d'un **accès Internet sortant** vers
  `download.osmand.net` pour récupérer la liste des cartes.
- Un `HEALTHCHECK` est intégré : le NAS affichera l'état « healthy » du
  conteneur une fois démarré.

## API

| Route                     | Description                                          |
| ------------------------- | ---------------------------------------------------- |
| `GET /`                   | Interface web                                        |
| `GET /api/maps`           | Liste des cartes en JSON                             |
| `GET /api/maps?refresh=1` | Force le rafraîchissement (ignore le cache)          |
| `GET /api/health`         | Vérification de l'état du serveur                    |

### Exemple de réponse `/api/maps`

```json
{
  "ok": true,
  "count": 1234,
  "cached": false,
  "source": "https://download.osmand.net/list.php",
  "items": [
    {
      "name": "Afghanistan_asia_2.obf.zip",
      "label": "Afghanistan",
      "region_group": "asia",
      "kind": "map",
      "size": 14.6,
      "date": "20.08.2024",
      "downloadUrl": "https://download.osmand.net/download.php?standard=yes&file=Afghanistan_asia_2.obf.zip"
    }
  ]
}
```

## Structure du projet

```
.
├── server.js          # Serveur + proxy + parseur HTML/XML → JSON
├── package.json
└── public/
    ├── index.html     # Interface
    ├── style.css      # Styles
    ├── app.js         # Logique front (carte, recherche, filtres, rendu)
    ├── vendor/        # Leaflet embarqué (js/css/images)
    └── data/
        └── countries.geo.json  # Contours des pays (fond de carte)
data/
    └── admin1.min.geo.json      # Contours des régions (états/provinces), servi
                                 # à la demande via /api/regions?country=…
```

## Remarques

- Le serveur envoie un `User-Agent` classique car certains serveurs refusent
  les clients anonymes.
- Le nombre d'entrées peut être important ; l'interface affiche au maximum
  500 résultats à la fois et invite à affiner la recherche au-delà.
