# Projets et worktrees

Un onglet de projet relie CodeNomad à un dossier sur l’ordinateur du backend. Ouvrir un onglet, parcourir une copie de travail et déplacer une famille de conversations sont des opérations distinctes.

## Ouvrir un projet {#open-project}

1. Cliquez sur **Nouvelle instance** (`+`) ou utilisez `Ctrl/Cmd+N` pour ouvrir un onglet vide. Le logo et le nom CodeNomad sont centrés au-dessus de deux colonnes : **Onglets récents** et la recherche à gauche ; **Parcourir** à droite, avec **Adresse ou lien du serveur** juste au-dessus de **Cloner un dépôt Git** et **Nouvel onglet temporaire** en bas. Le fond de la page reprend celui de l'onglet actif. Les colonnes s'empilent sur écran étroit. Le logo ouvre l'accueil : **Cloner un dépôt Git**, **Nouvel onglet temporaire**, **Nouveau SideCar** et la ligne OpenCode à gauche ; **Onglets récents | Parcourir** à droite, avec les nombres d'éléments sous les titres. Le panneau droit s'aligne sur le bas de la colonne gauche et sa liste défile à l'intérieur. L'accueil conserve la langue, les réglages, **Sponsor** ([Soutenir CodeNomad](sponsor.md)), GitHub, les étoiles et Discord. Clonage et dossiers temporaires ciblent le backend local. Choisir un projet local ou distant ou un SideCar remplit l'onglet vide sur place. Les onglets vides durent jusqu'au rechargement et se ferment sans laisser de projet.
2. Dans **Onglets récents**, choisissez un projet ; ou ouvrez **Parcourir**, choisissez **Cet ordinateur**, puis sélectionnez le dossier du backend et ouvrez-le. **Parcourir** liste aussi les serveurs CodeNomad enregistrés ([onglets de projets distants](remote-access.md#remote-project-tabs)) et les SideCars ([SideCars](browser-sidecars.md#register-sidecar)).
3. Pour une copie de dépôt, choisissez **Cloner un depot Git**, saisissez **URL du depot** et **Dossier de destination**, puis **Cloner**. **Dossier de destination** est prérempli avec le nom du dépôt, dans le dossier qui contient votre dernier clone, sinon à côté de votre projet le plus récent. **Parcourir** choisit le dossier qui contiendra le clone ; vous pouvez aussi modifier le chemin, y compris le nom du dossier du clone.

Parcourir un serveur distant signifie parcourir son système de fichiers, pas votre téléphone ou ordinateur portable. Ouvrir un projet ne crée pas un démon OpenCode distinct par onglet. Les conversations sont des sessions natives OpenCode ; leur durée de vie n’est pas celle de l’onglet.

Le nom du serveur choisi dans **Parcourir** reste visible pendant la connexion et la navigation. Les champs de connexion sont libellés ; **Récents** ouvre un projet, **Dossiers** parcourt les dossiers. **Ouvrir ce dossier** ouvre le dossier courant ; le retour à Parcourir affiche les serveurs. Seul le choix d'un projet remplit l'onglet vide. Limite connue : le backend de parcours et la vue native s'authentifient indépendamment ; l'onglet distant peut demander sa propre connexion.

Le clonage écrit un dépôt dans la destination. **Supprimer d'abord le dossier de destination s'il existe deja.** est destructeur : n’activez cette option que si tout ce qui s’y trouve peut être supprimé. Dans le doute, utilisez une nouvelle destination. Un échec de clonage n’est pas une raison de supprimer un projet existant ; vérifiez la destination et l’erreur signalées avant de réessayer.

Les récents sont des raccourcis. Les boutons en ligne sur l'accueil et le menu d'actions des onglets vides proposent **Renommer l'espace de travail** et **Retirer des récents** selon l'entrée ; retirer conserve fichiers et conversations. Partout, accueil, onglet vide et lanceur rapide, cliquer sur un projet local, distant ou un SideCar crée une nouvelle occurrence, même déjà ouvert. L'action séparée **Ouvert** (**Basculer vers le projet ouvert**) rejoint l'occurrence existante.

## Utiliser le lanceur de nouvelle instance {#new-instance-launcher}

1. Appuyez longuement ou faites un clic droit sur `+` ; lorsque ce bouton a le focus clavier, utilisez **Alt+Down**, **Shift+F10** ou la touche Menu.
2. **Onglets récents** contient la recherche et les projets locaux, distants et SideCars récents, avec leur action distincte **Ouvert**. Une ligne crée une nouvelle occurrence ; **Ouvert** rejoint l'existante. Le bouton sablier **Nouvel onglet temporaire**, dans la barre de titre, crée un onglet temporaire.

Un clic normal ouvre un onglet vide. Gérez les récents sur l'accueil ou un onglet vide, les serveurs dans **Paramètres → Serveurs** et les SideCars dans **Paramètres → SideCars**. Sur l'accueil, les onglets vides et le lanceur rapide, la sélection d'une ligne persiste uniquement pendant la navigation clavier ; le survol disparaît lorsque le pointeur sort. Échap ferme le lanceur et rend le focus à `+`.

## Fermer un onglet de projet {#close-stop}

1. Utilisez le bouton de fermeture de l’onglet ou **Fermer l'onglet** dans la palette de commandes (`Ctrl/Cmd+W` dans le moteur de rendu).
2. Fermer l’onglet ferme ce projet dans CodeNomad : il cesse de suivre ses événements et ses demandes. Les sessions continuent de s’exécuter dans OpenCode.
3. Rouvrez le dossier via Parcourir ou les dossiers récents pour retrouver ces conversations.

| Action | Portée et effet | Ce qu’elle ne fait pas |
| --- | --- | --- |
| Fermer l’onglet | Retire la connexion de projet CodeNomad de cet onglet ; un autre onglet ouvert séparément sur le même dossier n’est pas affecté | Ne supprime ni les fichiers du projet ni l’historique natif, n’arrête pas les sessions et ne décharge pas la Location d’OpenCode |
| Arrêter la session | Exécution de la conversation sélectionnée | Ne ferme pas le projet et ne supprime pas son historique |

Si une autre fenêtre affiche la même connexion de projet, son onglet se ferme aussi et cette fenêtre affiche une notification. La fenêtre à l’origine de la fermeture n’en affiche pas. La fermeture est immédiate ; si le backend ne peut pas fermer le projet, une erreur apparaît et **Basculer vers le projet ouvert** sur l’accueil permet encore d’y accéder. Il n’y a pas de nouvel essai automatique. Les brouillons non envoyés de l’onglet fermé ne sont pas conservés par la restauration au démarrage.

Fermer une fenêtre entière, quitter ou recharger ne ferme pas ses connexions de projet ; la restauration normale au démarrage s’applique toujours. Arrêtez explicitement les exécutions concernées si vous devez vérifier qu’elles sont terminées. CodeNomad ne décharge jamais les Locations natives ; la maintenance du service partagé est décrite dans [Configuration d’OpenCode](opencode.md).

## Espaces de travail temporaires {#temporary-workspaces}

1. Choisissez **Nouvel onglet temporaire** sous la liste de l'accueil ou d'un onglet vide.
2. Travaillez dans le dossier vide géré par CodeNomad ; Git n’est pas initialisé automatiquement.
3. À la fermeture de l’onglet, choisissez **Garder**, **Jeter** ou **Annuler**. Le menu de l’onglet propose aussi **Garder comme projet**.

| Choix | Effet | Récupération |
| --- | --- | --- |
| Garder | Ferme le projet dans CodeNomad, conserve le dossier et les conversations, retire son statut temporaire et ajoute un projet récent | Rouvrir depuis les dossiers récents ; le dossier n’est pas déplacé |
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
