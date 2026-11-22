# Projets et worktrees

Un onglet de projet relie CodeNomad à un dossier sur l’ordinateur du backend. Ouvrir un onglet, parcourir une copie de travail et déplacer une famille de conversations sont des opérations distinctes.

## Ouvrir un projet {#open-project}

Sans onglet à restaurer ou après la fermeture du dernier onglet, CodeNomad affiche un onglet vide. Cliquez sur **Nouvelle instance** (`+`) ou utilisez `Ctrl/Cmd+N` pour ouvrir un nouvel onglet vide. Choisissez un projet dans **Parcourir** ou **Onglets récents**. **Onglet temporaire** et **Cloner un dépôt** utilisent le serveur local.

Dans les onglets récents, **Ouvert** affiche l’onglet de cette fenêtre. Le point vert **Ouvert ailleurs** signale une connexion sur le serveur du projet en dehors de cette fenêtre. Cliquer sur la ligne ouvre un onglet distinct.

[Ouvrir un projet distant dans un onglet](remote-access.md#remote-project-tabs) · [SideCars](browser-sidecars.md#register-sidecar)

Pour une copie de dépôt, choisissez **Cloner un dépôt**, saisissez **URL du dépôt** et **Dossier de destination**, puis **Cloner**. **Dossier de destination** est prérempli avec le nom du dépôt, dans le dossier qui contient votre dernier clone, sinon à côté de votre projet le plus récent. **Parcourir** choisit le dossier qui contiendra le clone ; vous pouvez aussi modifier le chemin, y compris le nom du dossier du clone.

Parcourir un serveur distant signifie parcourir son système de fichiers, pas votre téléphone ou ordinateur portable. Ouvrir un projet ne crée pas un démon OpenCode distinct par onglet. Les conversations sont des sessions natives OpenCode ; leur durée de vie n’est pas celle de l’onglet.

Le clonage écrit un dépôt dans la destination. **Supprimer d'abord le dossier de destination s'il existe deja.** est destructeur : n’activez cette option que si tout ce qui s’y trouve peut être supprimé. Dans le doute, utilisez une nouvelle destination. Un échec de clonage n’est pas une raison de supprimer un projet existant ; vérifiez la destination et l’erreur signalées avant de réessayer.

Les récents sont des raccourcis. Le menu d’actions de l’onglet vide propose **Renommer l'espace de travail** et **Retirer des récents** selon l'entrée ; retirer conserve fichiers et conversations. Dans l’onglet vide et le lanceur rapide, cliquer sur un projet local, distant ou un SideCar crée une nouvelle occurrence, même déjà ouvert. L'action séparée **Ouvert** (**Basculer vers le projet ouvert**) rejoint l'occurrence existante.

L’action **Ouvert** sélectionne aussi un onglet qui attend son serveur et ferme l’onglet vide de départ.

## Utiliser le lanceur de nouvelle instance {#new-instance-launcher}

Appuyez longuement ou faites un clic droit sur `+` ; lorsque ce bouton a le focus clavier, utilisez **Alt+Down**, **Shift+F10** ou la touche Menu.
Tab ouvre la recherche, les flèches et Entrée sélectionnent, et Échap rend le focus à `+`.

## Fermer un onglet de projet {#close-stop}

1. Utilisez le bouton de fermeture de l’onglet ou **Fermer l'onglet** dans la palette de commandes (`Ctrl/Cmd+W` dans le moteur de rendu).
2. Fermer l’onglet ferme ce projet dans CodeNomad : il cesse de suivre ses événements et ses demandes. Les sessions continuent de s’exécuter dans OpenCode.
3. Rouvrez le dossier via Parcourir ou les dossiers récents pour retrouver ces conversations.

| Action | Portée et effet | Ce qu’elle ne fait pas |
| --- | --- | --- |
| Fermer l’onglet | Retire la connexion de projet CodeNomad de cet onglet ; un autre onglet ouvert séparément sur le même dossier n’est pas affecté | Ne supprime ni les fichiers du projet ni l’historique natif, n’arrête pas les sessions et ne décharge pas la Location d’OpenCode |
| Arrêter la session | Exécution de la conversation sélectionnée | Ne ferme pas le projet et ne supprime pas son historique |

Les brouillons et pièces jointes non envoyés de l’onglet fermé reviennent quand vous rouvrez le même dossier dans cette fenêtre ; elle les garde pour ses 16 derniers projets fermés, jusqu’à son rechargement ou sa fermeture. Ils ne font pas partie de la restauration au démarrage.

Lorsque vous fermez ou rechargez une fenêtre ou un onglet du navigateur, ou quittez l’application, CodeNomad demande aux serveurs de libérer les connexions de projet correspondantes. Un serveur inaccessible peut conserver les enregistrements. Les autres fenêtres gardent leurs onglets. La restauration au démarrage reconnecte les onglets enregistrés et conserve les dossiers temporaires ouverts. Pour arrêter une exécution, arrêtez-la explicitement ; voir [Configuration d’OpenCode](opencode.md) pour la maintenance du service partagé.

Lorsque la restauration au démarrage est activée, chaque onglet restant retrouve ses propres choix de panneaux, sa sélection et son lecteur de Mission ainsi que son choix entre le chat et l’aperçu web. Les URL et l’historique du navigateur sont partagés par session ; les pages enregistrées se chargent uniquement lorsque l’aperçu web est explicitement rouvert. Fermer une occurrence retire uniquement sa vue enregistrée ; rouvrir le dossier crée une nouvelle occurrence.

Un onglet dupliqué ouvre ses propres connexions de projet. Une connexion encore ouverte ne peut être réutilisée que si le navigateur a déchargé puis repris le même onglet.

## Restaurer les onglets distants {#restore-remote-tabs}

Au rechargement, si la restauration est activée, les onglets distants retrouvent leur ordre, leur sélection et leurs brouillons. Un serveur indisponible laisse un onglet en attente : choisissez **Réessayer** à son retour, ou **Se connecter** avec son nom d’utilisateur/mot de passe ou un lien dans **Nouveau lien d’appairage**. Les autres serveurs restent utilisables. **Serveur introuvable** signifie que le serveur enregistré est introuvable.

**Réessayer** reconnecte le projet sur le serveur enregistré et recrée sa connexion si nécessaire.

**Réessayer** reprend aussi les onglets en attente lorsque la restauration automatique au démarrage est désactivée. Les notifications sélectionnent l’onglet en attente existant. Vérifiez le résultat d’une action de conversation incertaine avant de la renvoyer.

## Espaces de travail temporaires {#temporary-workspaces}

1. Choisissez **Onglet temporaire** en haut de l’onglet vide.
2. Travaillez dans le dossier vide géré par CodeNomad ; Git n’est pas initialisé automatiquement.
3. À la fermeture de l’onglet, choisissez **Garder**, **Jeter** ou **Annuler**. Le menu de l’onglet propose aussi **Garder comme projet**.

| Choix | Effet | Récupération |
| --- | --- | --- |
| Garder | Ferme le projet dans CodeNomad, conserve le dossier et les conversations, retire son statut temporaire et ajoute un projet récent | Rouvrir depuis les dossiers récents ; le dossier n’est pas déplacé |
| Jeter | Supprime les conversations, fichiers et brouillons non envoyés de l’espace de travail temporaire | Aucune annulation ; enregistrez d’abord ailleurs ce dont vous avez besoin |
| Annuler | Laisse l’espace de travail temporaire ouvert | Continuer à travailler ou décider plus tard |

Un onglet temporaire intact, sans conversation, fichier ni brouillon non envoyé, est supprimé discrètement à la fermeture. Les onglets temporaires ouverts participent à la restauration normale au démarrage.

La suppression est refusée si une conversation est active ou si le dossier est ouvert dans un autre onglet/une autre fenêtre. Arrêtez l’exécution et fermez d’abord les autres vues. En cas d’échec, l’espace reste temporaire : résolvez le problème signalé et réessayez plutôt que de supprimer manuellement un répertoire parent.

## Sélectionner ou créer un worktree {#select-create-worktree}

1. Ouvrez une conversation parente et utilisez le sélecteur de worktree de sa zone de saisie. Sur les dispositions étroites, il se réduit à une flèche.
2. Sélectionnez un worktree découvert existant ou choisissez **+ Créer un worktree**.
3. Pour une création, saisissez **Nom** et choisissez **Créer et utiliser le worktree**.

Quand le projet est un dossier situé dans un dépôt, seuls les worktrees qui contiennent ce dossier sont proposés. Pour créer un worktree depuis un tel dossier, Git doit le suivre. Un nouveau nom de branche part du HEAD de la copie sélectionnée. Un nom de branche existant utilise sa révision actuelle ; Git peut refuser une branche déjà extraite ailleurs. Les worktrees utilisent l’emplacement par défaut `.codenomad/worktrees`. Les modifications non validées restent dans la copie d’origine ; la création ne les copie pas dans le nouveau worktree.

Le sélecteur de la zone de saisie déplace la conversation parente et ses descendants récursifs en tant que famille vérifiée. Une sous-session ne peut pas modifier ce sélecteur indépendamment. Les sessions actives bloquent l’opération : laissez la famille terminer ou arrêtez d’abord son exécution. Attendez qu’un déplacement soit réglé avant d’en demander un autre ; en cas d’erreur, vérifiez l’état actualisé de la conversation/du worktree avant de réessayer.

À l’inverse, **Worktree à consulter** dans [Fichiers](files.md) change seulement la copie lue par le panneau. Cela ne déplace pas une conversation, ne change pas de branche et ne change pas le lieu d’exécution de sa prochaine commande shell.

## Supprimer un worktree {#remove-worktree}

1. Dans la liste des worktrees de la zone de saisie, utilisez **Supprimer le worktree** pour un worktree de branche supprimable.
2. Vérifiez le dossier cible. Laissez **Forcer la suppression (jeter les modifications locales)** désactivé sauf si les modifications locales peuvent être perdues.
3. Confirmez la suppression et vérifiez l’inventaire résultant.

La suppression retire le dossier local du worktree. La copie principale de Git n’est pas une cible supprimable. CodeNomad ramène les familles de conversations concernées vers la copie racine et vérifie leur emplacement avant de retirer le worktree ; des sessions actives peuvent bloquer la suppression. La suppression n’est ni une archive ni une sauvegarde des fichiers non validés.

Si Git refuse des fichiers modifiés/non suivis, préservez ou nettoyez ces fichiers avant de réessayer. La suppression forcée les détruit explicitement. Pour un répertoire verrouillé, fermez les terminaux, éditeurs, observateurs et processus en arrière-plan qui l’utilisent. La boîte d’erreur propose **Copier la version nettoyée** pour partager un diagnostic ; relisez même le texte nettoyé.

## Initialiser Git ou travailler sans lui {#initialize-git}

1. Pour un dossier ordinaire avec Git disponible, ouvrez **Fichiers → Changements** ou **Commits**.
2. Choisissez **Initialiser Git**. L’action est immédiate, sans confirmation supplémentaire.
3. Attendez l’actualisation des métadonnées du projet et des conversations ; utilisez **Actualiser** si Git a été initialisé hors de CodeNomad.

L’initialisation crée le dépôt dans le dossier explicitement ouvert, pas dans son parent. Elle ne crée pas de commit.

Si le backend ne peut pas exécuter Git, les conversations et la navigation bornée dans les fichiers restent disponibles pour le dossier explicitement ouvert, en mode répertoire seul. Les opérations de worktree et l’initialisation Git nécessitent Git sur ce backend. Consultez [Installation](install.md) et [Fichiers](files.md).
