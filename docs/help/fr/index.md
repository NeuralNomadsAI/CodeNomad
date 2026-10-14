# Aide CodeNomad

Ce guide explique comment utiliser l’espace de travail CodeNomad actuel, sur ordinateur ou dans un navigateur, avec votre service OpenCode. Il porte sur les commandes de CodeNomad, les limites d’exécution et la récupération, et non sur la configuration d’OpenCode ou un historique des versions.

## À lire en premier {#read-this-first}

CodeNomad relie votre espace de travail à un service OpenCode partagé en arrière-plan. Les sessions et les messages appartiennent à OpenCode ; les onglets, brouillons de saisie et dispositions appartiennent au client CodeNomad. Fermer un onglet n’arrête pas un espace de travail, et fermer CodeNomad n’arrête pas OpenCode.

1. Vérifiez les [prérequis de l’hôte](install.md#requirements) et la [configuration d’OpenCode](opencode.md).
2. [Ouvrez un projet](projects.md), puis choisissez les réglages Agent, Modèle et Réflexion de la conversation.
3. Vérifiez la portée concernée avant de modifier des identifiants, de redémarrer un service ou de supprimer l’historique. D’autres clients peuvent utiliser le même service natif.

Le site d’aide public fonctionne sans CodeNomad, son backend ni connexion. **Aide → Aide de CodeNomad** sur ordinateur et **Ouvrir l’aide** dans la palette de commandes l’ouvrent séparément dans la langue actuelle de l’interface. Changer de langue ne traduit pas les conversations enregistrées.

**Paramètres** ouvre la fenêtre native **Préférences** dans un client de bureau local ; les clients navigateur et distants utilisent les paramètres intégrés. Les chemins tels que **Paramètres → Fournisseurs** désignent la même section dans les deux interfaces.

Pour un espace de travail autonome dans un navigateur sur un hôte préparé, le [guide du serveur](server.md) explique cette commande et ses exigences d’authentification/TLS :

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

## Choisir son client {#choose-your-client}

| Fonctionnalité | Bureau local | Navigateur direct ou fenêtre de serveur distant | Appareil appairé au Contrôle à distance |
| --- | --- | --- | --- |
| Projets, conversations, fichiers et historique | Dossiers du backend et sessions natives | Dossiers et sessions du serveur connecté | Surfaces autorisées de l’espace de travail de l’hôte |
| Préférences natives et fenêtres de bureau | Disponibles | Les paramètres navigateur/distants restent dans le client | Commandes réservées au bureau hôte indisponibles |
| Aperçu navigateur de session | Natif dans Electron et Tauri Windows ; iframe sur les autres plateformes Tauri | Iframe si disponible | Points d’accès d’aperçu réservés à l’hôte indisponibles |
| Automatisation native du bureau/navigateur | Fenêtres/aperçus locaux détenus | Ne remplace pas l’automatisation native du bureau | Points d’accès d’automatisation réservés à l’hôte indisponibles |
| Authentification | Initialisation locale ou session par mot de passe | Session par mot de passe du serveur | Identifiant d’appareil appairé |
| Installation PWA | Utiliser l’application native ou un navigateur | Selon le navigateur ; contexte sécurisé requis | Selon le navigateur ; appairage toujours requis |

Pour les limites précises, consultez [aperçus navigateur et SideCars](browser-sidecars.md), [Contrôle à distance](remote-control.md) et [mobile/PWA](mobile.md). Une fenêtre distante ne transforme pas le système de fichiers de votre appareil en espace de travail du serveur.

## Savoir à qui appartient l’état {#state-and-scope}

| Terme | Sens dans CodeNomad |
| --- | --- |
| Onglet de projet / espace de travail / instance | Connexion CodeNomad à un dossier explicitement ouvert ; plusieurs onglets peuvent utiliser le service partagé. |
| Conversation / session | Historique et exécution natifs OpenCode associés à leur répertoire. |
| Famille | Conversation et ses sous-sessions récursives ; intervient dans les déplacements, l’activité, Yolo et les commandes des Missions. |
| Worktree | Copie de travail détenue d’un dépôt, sélectionnée pour la navigation ou l’emplacement des sessions. La parcourir ne déplace pas une conversation. |
| Location | Contexte d’exécution natif OpenCode propre à un répertoire ; **Arrêter l'espace de travail** libère ses ressources, pas le démon partagé. |
| Backend CodeNomad | Serveur fournissant l’espace de travail, Git, l’authentification et la connectivité des clients. Son compte et son environnement déterminent l’accès au système de fichiers du backend. |
| Configuration | Paramètres CodeNomad dans le répertoire de configuration du serveur ; les paramètres OpenCode Global/Projet ont leur propre portée native. |
| Fenêtre | Ses propres onglets, navigation, brouillons et vue restaurée. L’historique natif est partagé, pas copié pour chaque fenêtre. |
| Profil de données de bureau | Sélection explicite du stockage natif/client ; n’isole pas automatiquement les sessions OpenCode ni toute la configuration partagée. |

La racine de l’espace de travail limite les dossiers que CodeNomad ouvre ; ce n’est pas un bac à sable pour l’agent. Consultez la [sécurité](security.md) avant d’exposer un hôte ou d’autoriser un accès étendu aux outils.

## Explorer par tâche {#explore-by-task}

| Tâche | Guide |
| --- | --- |
| Installer ou servir l’espace de travail | [Installation](install.md), [Référence serveur](server.md), [Réseau et TLS](remote-access.md) |
| Travailler avec plusieurs copies de travail et conversations | [Projets](projects.md), [Conversations](conversations.md), [Fichiers](files.md) |
| Rechercher dans l’historique ou le nettoyer sans risque | [Historique](history.md) |
| Répondre aux questions et autorisations natives | [Autorisations](permissions.md) |
| Coordonner un travail délimité ou quotidien | [Missions](missions.md) |
| Configurer l’exécution et les intégrations | [OpenCode](opencode.md), [Fournisseurs](providers.md), [Intégrations](integrations.md) |
| Connecter un autre appareil | [Contrôle à distance](remote-control.md), [Sécurité](security.md), [Mobile](mobile.md) |
| Adapter l’espace de travail | [Paramètres](settings.md), [Raccourcis](shortcuts.md), [Voix](voice.md), [Extensions](extensions.md) |
| Gérer l’application native | [Bureau](desktop.md), [Aperçus navigateur et SideCars](browser-sidecars.md), [Mises à jour](updates.md) |
| Diagnostiquer ou contribuer | [Dépannage](troubleshooting.md), [Assistance et compilation depuis les sources](support.md) |

## Surveiller le travail sans le modifier {#monitor-work}

Le panneau Statut expose l’utilisation du fournisseur de la session active et les Shells natifs en arrière-plan. Le statut des conversations et l’activité des enfants indiquent les sessions actives, en compactage ou en attente de saisie. Surveiller un Shell en arrière-plan est distinct de l’envoi d’une demande Shell depuis la zone de saisie ou de l’utilisation d’un SideCar terminal hébergé séparément.

1. Ouvrez **Statut → Shells en arrière-plan** pour la Location de la conversation sélectionnée (ou l’espace de travail ouvert si aucune conversation n’est sélectionnée).
2. Consultez la commande, le shell, le répertoire, le statut, le PID et le code de sortie lorsqu’ils sont fournis ; choisissez **Afficher la sortie** pour voir la sortie native disponible.
3. Pour en retirer un, utilisez **Arrêter et supprimer** pendant son exécution, ou **Supprimer** après sa sortie, et confirmez la cible.

Supprimer un Shell en cours arrête ce processus ; fermer sa fenêtre de sortie ne l’arrête pas. L’actualisation ou la reconnexion lit l’état natif actuel au lieu de reconstruire les événements de sortie manqués.

Les instantanés d’affichage s’actualisent après les changements natifs, la reconnexion et à la demande des vues visibles. Ce ne sont pas des journaux de rejeu garantis. Si un résultat est incertain, actualisez l’état faisant autorité avant de réessayer une modification ; ne renvoyez pas la demande simplement parce qu’une notification ou un événement a été manqué.
