# Projets et worktrees

Un onglet de projet relie CodeNomad à un dossier sur l’ordinateur du backend. Ouvrir un onglet, parcourir une copie de travail et déplacer une famille de conversations sont des opérations distinctes.

## Ouvrir un projet {#open-project}

1. Cliquez sur **Nouvelle instance** (`+`) pour ouvrir l’accueil.
2. Choisissez **Parcourir les dossiers**, sélectionnez le dossier du backend et ouvrez-le ; ou choisissez une entrée sous **Dossiers récents**.
3. Pour une copie de dépôt, choisissez **Cloner un depot Git**, saisissez **URL du depot** et **Dossier de destination**, puis **Cloner**.

Parcourir un serveur distant signifie parcourir son système de fichiers, pas votre téléphone ou ordinateur portable. Ouvrir un projet ne crée pas un démon OpenCode distinct par onglet. Les conversations sont des sessions natives OpenCode ; leur durée de vie n’est pas celle de l’onglet.

Le clonage écrit un dépôt dans la destination. **Supprimer d'abord le dossier de destination s'il existe deja.** est destructeur : n’activez cette option que si tout ce qui s’y trouve peut être supprimé. Dans le doute, utilisez une nouvelle destination. Un échec de clonage n’est pas une raison de supprimer un projet existant ; vérifiez la destination et l’erreur signalées avant de réessayer.

Les entrées récentes sont des raccourcis. **Renommer l'espace de travail** change son nom affiché ; **Retirer des récents** retire le raccourci, pas ses fichiers ni ses conversations. Un projet récent déjà ouvert peut basculer vers son onglet existant.

## Utiliser le lanceur de nouvelle instance {#new-instance-launcher}

1. Appuyez longuement ou faites un clic droit sur `+` ; lorsque ce bouton a le focus clavier, utilisez **Alt+Down**, **Shift+F10** ou la touche Menu.
2. Recherchez les projets récents ou sélectionnez **Parcourir…**, **Temporaire** ou **Cloner…**.
3. Utilisez **Serveurs distants**, **SideCar** ou **Accueil complet** pour les autres destinations.

Un clic normal ouvre toujours l’accueil complet. Le lanceur est un raccourci, pas l’interface de gestion : renommez/retirez les projets récents et gérez les serveurs enregistrés depuis l’accueil. Échap ferme le lanceur et rend le focus à `+`.

## Fermer un onglet de projet {#close-stop}

1. Utilisez le bouton de fermeture de l’onglet ou **Fermer l'onglet** dans la palette de commandes pour fermer le projet dans CodeNomad. CodeNomad cesse de suivre cette instance ouverte du projet.
2. Les sessions continuent de s’exécuter dans OpenCode ; les fichiers du projet et l’historique natif sont conservés.
3. Rouvrez le dossier via Parcourir ou les dossiers récents pour retrouver les sessions.

| Action | Portée et effet | Ce qu’elle ne fait pas |
| --- | --- | --- |
| Fermer l’onglet | Ferme cette instance ouverte du projet dans CodeNomad | Ne supprime ni fichiers ni sessions natives et n’arrête ni la génération ni le service OpenCode partagé |
| Arrêter la session | Exécution de la conversation sélectionnée | Ne ferme pas le projet et ne supprime pas son historique |

Un autre onglet du même dossier ouvert séparément n’est pas affecté. Si une autre fenêtre affiche la même instance ouverte du projet, son onglet se ferme aussi et cette fenêtre affiche une notification. CodeNomad ne décharge pas la Location native OpenCode. Arrêtez explicitement les exécutions concernées avant de fermer si vous souhaitez les terminer. La maintenance du service partagé est décrite dans [Configuration d’OpenCode](opencode.md).

## Espaces de travail temporaires {#temporary-workspaces}

1. Choisissez **Temporaire** dans le lanceur ou **Nouvelle instance temporaire** sur l’accueil.
2. Travaillez dans le dossier vide géré par CodeNomad ; Git n’est pas initialisé automatiquement.
3. À la fermeture de l’onglet, choisissez **Garder**, **Jeter** ou **Annuler**. Après **Garder**, l’onglet se ferme comme un onglet de projet ordinaire. Le menu de l’onglet propose aussi **Garder comme projet**.

| Choix | Effet | Récupération |
| --- | --- | --- |
| Garder | Conserve le dossier et les conversations, retire son statut temporaire et ajoute un projet récent | Rouvrir depuis les dossiers récents ; le dossier n’est pas déplacé |
| Jeter | Supprime les conversations et fichiers de l’espace de travail temporaire | Aucune annulation ; enregistrez d’abord ailleurs ce dont vous avez besoin |
| Annuler | Laisse l’espace de travail temporaire ouvert | Continuer à travailler ou décider plus tard |

Un onglet temporaire intact, sans conversation, fichier ni brouillon non envoyé, est supprimé discrètement à la fermeture. Les onglets temporaires ouverts participent à la restauration normale au démarrage, mais l’accueil n’a pas de liste séparée pour reprendre les dossiers temporaires fermés.

La suppression est refusée si une conversation est active ou si le dossier est ouvert dans un autre onglet/une autre fenêtre. Arrêtez l’exécution et fermez d’abord les autres vues. En cas d’échec, l’espace reste temporaire : résolvez le problème signalé et réessayez plutôt que de supprimer manuellement un répertoire parent.

## Sélectionner ou créer un worktree {#select-create-worktree}

1. Ouvrez une conversation parente et utilisez le sélecteur de worktree de sa zone de saisie. Sur les dispositions étroites, il se réduit à une flèche.
2. Sélectionnez un worktree découvert existant ou choisissez **+ Créer un worktree**.
3. Pour une création, saisissez **Nom** et choisissez **Créer et utiliser le worktree**.

CodeNomad découvre les worktrees via OpenCode et vérifie qu’ils appartiennent au dépôt ouvert. Un nouveau nom de branche part du HEAD de la copie sélectionnée. Un nom de branche existant utilise sa révision actuelle ; Git peut refuser une branche déjà extraite ailleurs. Les worktrees utilisent l’emplacement par défaut `.codenomad/worktrees`. Les modifications non validées restent dans la copie d’origine ; la création ne les copie pas dans le nouveau worktree.

Le sélecteur de la zone de saisie déplace la conversation parente et ses descendants récursifs en tant que famille vérifiée. Une sous-session ne peut pas modifier ce sélecteur indépendamment. Les sessions actives bloquent l’opération : laissez la famille terminer ou arrêtez d’abord son exécution. Attendez qu’un déplacement soit réglé avant d’en demander un autre ; en cas d’erreur, vérifiez l’état actualisé de la conversation/du worktree avant de réessayer.

À l’inverse, **Worktree à consulter** dans [Fichiers](files.md) change seulement la copie lue par le panneau. Cela ne déplace pas une conversation, ne change pas de branche et ne change pas le lieu d’exécution de sa prochaine commande shell.

## Supprimer un worktree {#remove-worktree}

1. Dans la liste des worktrees de la zone de saisie, utilisez **Supprimer le worktree** pour un worktree de branche supprimable.
2. Vérifiez le dossier cible. Laissez **Forcer la suppression (jeter les modifications locales)** désactivé sauf si les modifications locales peuvent être perdues.
3. Confirmez la suppression et vérifiez l’inventaire résultant.

La suppression retire le dossier local du worktree. La copie principale de Git n’est pas une cible supprimable. CodeNomad ramène les familles de conversations concernées vers la copie racine et vérifie leur emplacement avant de retirer le worktree ; des sessions actives peuvent bloquer la suppression. La suppression n’est ni une archive ni une sauvegarde des fichiers non validés.

Si Git refuse des fichiers modifiés/non suivis, préservez ou nettoyez ces fichiers avant de réessayer. La suppression forcée les détruit explicitement. Pour un répertoire verrouillé, fermez les terminaux, éditeurs, observateurs et processus en arrière-plan qui l’utilisent. Pour une entrée manquante, actualisez les worktrees et inspectez le chemin avant de réessayer. La boîte d’erreur propose **Copier la version nettoyee** pour partager un diagnostic ; relisez même le texte nettoyé.

## Initialiser Git ou travailler sans lui {#initialize-git}

1. Pour un dossier ordinaire avec Git disponible, ouvrez **Fichiers → Changements** ou **Commits**.
2. Choisissez **Initialiser Git**. L’action est immédiate, sans confirmation supplémentaire.
3. Attendez l’actualisation des métadonnées du projet et des conversations ; utilisez **Actualiser** si Git a été initialisé hors de CodeNomad.

L’initialisation crée le dépôt dans le dossier explicitement ouvert, pas dans son parent. Elle ne crée pas de commit. En cas d’échec, consultez le message et actualisez avant de réessayer : une réponse incertaine n’est pas rejouée automatiquement.

Si le backend ne peut pas exécuter Git, les conversations et la navigation bornée dans les fichiers restent disponibles pour le dossier explicitement ouvert, en mode répertoire seul. Les opérations de worktree et l’initialisation Git nécessitent Git sur ce backend. Consultez [Installation](install.md) et [Fichiers](files.md).
