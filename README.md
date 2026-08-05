# DlMapOsmAnd — Cartes OsmAnd

Application web pour **récupérer, lister et rechercher** toutes les cartes
disponibles sur [`download.osmand.net/list.php`](https://download.osmand.net/list.php).

![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen) ![deps](https://img.shields.io/badge/d%C3%A9pendances-0-blue)

## Fonctionnalités

- 🔎 **Barre de recherche** instantanée (pays, région, description…)
- 🗂️ **Filtres** par type (carte, courbes de niveau, Wikipédia, voix…) et par continent
- ↕️ **Tri** par nom, taille ou date
- ⬇️ **Lien de téléchargement direct** pour chaque carte
- ⚡ **Zéro dépendance** : uniquement Node.js natif (`http`/`https`)
- 🧠 **Cache serveur** (1 h) pour ne pas surcharger les serveurs OsmAnd

## Pourquoi un petit serveur ?

`list.php` ne renvoie pas d'en-têtes CORS. Un `fetch` lancé directement depuis
le navigateur serait donc bloqué. Le serveur Node fait office de **proxy** :
il récupère le XML de `list.php`, le transforme en JSON propre, et sert le
frontend statique. Aucun service tiers n'est nécessaire.

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
├── server.js          # Serveur + proxy + parseur XML → JSON
├── package.json
└── public/
    ├── index.html     # Interface
    ├── style.css      # Styles
    └── app.js         # Logique front (recherche, filtres, rendu)
```

## Remarques

- Le serveur envoie un `User-Agent` classique car certains serveurs refusent
  les clients anonymes.
- Le nombre d'entrées peut être important ; l'interface affiche au maximum
  500 résultats à la fois et invite à affiner la recherche au-delà.
