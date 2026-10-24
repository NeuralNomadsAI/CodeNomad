# Assistance et compilation depuis les sources

Utilisez le dépôt pour les signalements de bugs, versions actuelles et contributions. Le [guide de dépannage](troubleshooting.md) couvre la récupération sûre avant de signaler un problème.

## Signaler un bug {#report-a-bug}

1. Ouvrez **Paramètres → Info → Diagnostics**.
2. Sélectionnez **Signaler un bug** pour ouvrir le formulaire de ticket GitHub.
3. Vérifiez les informations de version/client préremplies. Ajoutez une reproduction minimale, le comportement attendu et le résultat réel, puis soumettez via GitHub.

L’action préremplit les versions de CodeNomad et d’OpenCode (y compris celle du service OpenCode en cours lorsqu’elle diffère de la version installée), votre système d’exploitation, le type de client (avec l’agent utilisateur du navigateur dans un navigateur web) et le système d’exploitation du serveur. Elle ne préremplit pas les adresses d’écoute, chemins de travail, identifiants ou textes de conversation. Ouvrir le formulaire ne soumet pas de ticket.

Pour davantage de diagnostics, **Copier dans le presse-papiers** ou **Télécharger .txt** produit un rapport distinct. Ce rapport plus complet peut contenir des chemins locaux et adresses réseau : relisez-le et masquez-les avant de le joindre. Une capture ou un extrait de journal peut encore contenir des secrets même si le diagnostic automatique exclut les secrets d’authentification.

Si le formulaire GitHub contient des champs incompatibles, CodeNomad ouvre un ticket simple avec les mêmes informations. Un échec temporaire de lecture du formulaire n’empêche pas son ouverture. Vous pouvez toujours utiliser manuellement la [liste des tickets](https://github.com/NeuralNomadsAI/CodeNomad/issues).

## Communauté et versions {#community}

| Ressource | Utilisation |
| --- | --- |
| [Dépôt CodeNomad](https://github.com/NeuralNomadsAI/CodeNomad) | Sources, activité du projet et documentation. |
| [Tickets](https://github.com/NeuralNomadsAI/CodeNomad/issues) | Rechercher les signalements existants avant un bug reproductible ou une demande de fonctionnalité. |
| [Pull requests](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | Examiner les changements proposés ou coordonner une contribution. |
| [Dernière version](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Téléchargements stables. |
| [Toutes les versions](https://github.com/NeuralNomadsAI/CodeNomad/releases) | Préversions publiées et notes de version. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | Organisation du projet. |
| [Licence MIT](../../../LICENSE) | Conditions de licence. |

Pour les problèmes de configuration native OpenCode plutôt que de commandes CodeNomad, consultez la [documentation OpenCode](https://opencode.ai/v2/docs/) et les [versions amont](https://github.com/anomalyco/opencode/releases).

## Compiler depuis les sources {#build-from-source}

Utilisez Node.js **24.20.0**, épinglé dans `.node-version`, npm, Git et une CLI OpenCode compatible. Exécutez les commandes depuis une copie de développement :

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` démarre l’hôte de développement Electron. Pour Tauri, installez d’abord ses [prérequis de compilation de plateforme](https://v2.tauri.app/start/prerequisites/), dont la chaîne Rust, puis exécutez :

```sh
npm run dev:tauri
```

Les changements de développement affectent l’hôte de développement, pas la version installée d’un démon OpenCode indépendant actif. La création de paquets natifs nécessite les outils de cible appropriés ; privilégiez une compilation sur le système cible.

### Compiler et valider {#build-and-validate}

| Commande, depuis la racine du dépôt | But |
| --- | --- |
| `npm run build` | Compiler les ressources de l’application Electron. |
| `npm run build:tauri` | Compiler l’application Tauri avec ses prérequis natifs. |
| `npm run build:ui` | Compiler l’interface navigateur. |
| `npm run build --workspace @neuralnomads/codenomad` | Compiler le serveur autonome et les ressources fournies. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Créer le paquet Debian Electron. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Créer une AppImage Tauri Linux. |
| `npm run typecheck` | Vérifier les espaces de travail TypeScript configurés à la racine. |
| `npm run test:help` | Valider toutes les langues et tous les liens de l’aide publique. |
| `npm run build:help` | Compiler l’aide publique autonome dans `dist/help`. |

La compilation de l’aide ne nécessite pas de service CodeNomad ou OpenCode actif. Voir [BUILD.md](../../../BUILD.md) pour les détails de création des paquets et [CONTRIBUTING.md](../../../CONTRIBUTING.md) pour la validation ciblée et les conventions de PR ; utilisez les scripts réellement présents dans le paquet cible.

## Carte des paquets et contribution {#contribute}

| Paquet | Responsabilité |
| --- | --- |
| `packages/server` | Commandes espace de travail/API/Git, connexion OpenCode, authentification, événements et voix. |
| `packages/ui` | Espace de travail SolidJS, commandes, localisation et point d’entrée de l’aide navigateur. |
| `packages/electron-app` | Fenêtres Electron, intégration native et création des paquets. |
| `packages/tauri-app` | Fenêtres Tauri, intégration de plateforme et création des paquets. |
| `packages/remote-tunnel` | Environnement de transport OpenTunnel côté backend. |

1. Discutez de la portée dans le ticket pertinent avant de réaliser un travail qui se chevauche.
2. Créez votre branche depuis `dev` et gardez le changement ciblé.
3. Exécutez les contrôles de la zone concernée, mettez l’aide à jour avec le comportement et ciblez `dev` pour votre PR.

Les sources d’aide publique se trouvent dans `docs/help/<locale>/`. Préservez l’ID explicite, le niveau et l’ordre de chaque titre anglais dans les traductions ; les titres traduits ne doivent pas casser les liens profonds. Le [contrat de maintenance de l’aide](../../../dev-docs/USER_HELP.md) décrit les contrôles stricts d’exhaustivité et le pipeline de publication statique.
