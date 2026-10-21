# Conversations

CodeNomad présente les sessions natives OpenCode comme des conversations, avec une hiérarchie pour le travail délégué et des commandes distinctes pour votre prochain envoi.

Les messages affichent du Markdown, du code, des diffs et les images de résultats d’outils prises en charge. La copie de texte, la recherche dans l’historique complet et la voix utilisent des projections textuelles, pas les octets des images intégrées. **Contenu des messages** change la visibilité sans supprimer les parties enregistrées ; [Historique](history.md#operation-reference) distingue les commandes d’affichage du nettoyage.

Les en-têtes de raisonnement et d’outils indiquent la durée de chaque étape, comptée en direct pendant son exécution ; les durées inférieures à une seconde ne sont pas affichées. Lorsque **Tokens** est affiché dans **Contenu des messages** (le préréglage **Tout** l’affiche), chaque message d’agent se termine par une seule ligne de tokens et de coût après son texte final. Cette ligne additionne le message et les messages contenant les outils et raisonnements que couvre son action **Supprimer les outils et raisonnements de cette réponse**, dans la transcription chargée ; dépliez-la pour les comptes de raisonnement et de cache. Les étapes qui n’ont exécuté que des outils n’ont pas de ligne propre.

## Trouver des conversations et naviguer {#navigate-conversations}

1. Sélectionnez une ligne sous **Sessions**, ou utilisez **Nouvelle session** pour démarrer une conversation parente.
2. Dépliez le chevron d’un parent pour voir ses sous-sessions. Un chevron replié affiche l’état le plus urgent de ses descendants : en attente de saisie, actif ou récemment terminé (inactif) ; son infobulle les compte.
3. Utilisez **Rechercher des sessions…**, **Sessions principales** / **Sous-sessions**, le filtre de worktree et le tri **Activité**, **Nom** ou **Worktree** pour réduire la liste.
4. Utilisez **Retour** et **Avancer** dans la barre latérale pour revisiter les conversations affichées.

La navigation normale est hiérarchique ; les résultats de recherche/filtre sont des entrées à plat avec l’identité et le worktree propres à chaque conversation. Une sous-session qui commence à travailler n’est révélée automatiquement que sous la famille de la conversation active. Replier cette branche annule cette révélation automatique pour les descendants actuellement en cours.

Retour/Avancer est un historique de visites par onglet de projet et par fenêtre, pas l’ordre de la liste. Il reste en mémoire, ignore les conversations indisponibles/supprimées et n’est pas restauré après redémarrage. Sélectionner une nouvelle conversation après un retour remplace le parcours suivant. **Session précédente** / **Session suivante** dans la palette parcourent plutôt la liste visible.

## Choisir Agent, Modèle et Réflexion {#agent-model-thinking}

1. Utilisez les sélecteurs d’agent et de modèle du pied de la zone de saisie avant l’envoi.
2. Si le modèle expose des variantes, sélectionnez son effort de **Réflexion** ; **Par défaut** laisse la valeur native par défaut.
3. Envoyez le prochain prompt et vérifiez les métadonnées agent/modèle de la réponse pour diagnostiquer un résultat.

Une nouvelle conversation démarre avec l’agent qu’OpenCode résout comme agent par défaut, qu’un plugin peut définir, sauf si vous en choisissez un autre. Les infobulles des sélecteurs indiquent leurs raccourcis.

Ces choix d’exécution concernent les envois suivants, pas les réponses antérieures. Lire un ancien passage dans la chronologie ne remplace pas les choix actuels de la zone de saisie par les métadonnées historiques. La visibilité des modèles, les favoris et les connexions fournisseurs se gèrent dans [Fournisseurs](providers.md).

## Brouillons et pièces jointes {#drafts-attachments}

1. Rédigez dans la conversation sélectionnée. Changer de conversation conserve son brouillon au lieu de l’envoyer.
2. Choisissez **Joindre un fichier…** dans le menu **Plus d'actions** de la zone de saisie, ou déposez ou collez, pour des fichiers de cet appareil ; ou tapez `@` pour sélectionner des fichiers du projet, agents ou compétences.
3. Vérifiez les étiquettes des pièces jointes et retirez tout ce qui n’est pas destiné au prochain envoi.

| Entrée | Source et effet |
| --- | --- |
| Pièce jointe de l’appareil | Le sélecteur, le dépôt ou le presse-papiers lit des octets depuis l’appareil exécutant l’interface ; ce n’est pas un chemin serveur |
| Référence de projet `@` | Résolue dans le projet/la Location de la conversation sur le backend, y compris son worktree |
| Mention d’agent | Joint la référence de l’agent sélectionné plutôt que de modifier les messages passés |
| Compétence | Recherche les compétences de la Location par nom/description et joint une sélection de compétence retirable |

Les fichiers de l’appareil doivent être lisibles et respecter le budget de pièces jointes : au maximum 5 Mio chacun, 10 fichiers et 20 Mio au total. Un fichier refusé n’est pas joint ; lisez l’avis au lieu de supposer que toute la sélection a réussi.

Choisir une compétence retire le jeton `@query` et ajoute une étiquette. L’envoi efface cette sélection de la zone de saisie, pas les instructions déjà enregistrées par OpenCode avec le message envoyé. Les messages historiques conservent les étiquettes de compétences. Retirer une compétence pendant la modification d’un prompt en attente la laisse retirée de l’envoi de remplacement.

Sur ordinateur, l’envoi place le focus clavier sur la conversation : les flèches, les touches de défilement par page et Espace la font défiler ; taper un caractère revient à la zone de saisie avec ce caractère. **Effacer le texte du prompt** dans **Plus d'actions** (par défaut **Ctrl/Cmd+K**) efface le brouillon de la zone de saisie.

Les brouillons sont un état de travail côté client, pas des messages natifs partagés. La restauration au démarrage peut conserver l’état de saisie pris en charge, mais ne considérez pas un brouillon non envoyé ou une pièce jointe comme une sauvegarde, ni comme disponible sur un autre appareil. Enregistrez le texte important avant d’effacer les données de démarrage ou de fermer un client dont la restauration est désactivée ; voir [Bureau](desktop.md).

## Commandes et mode shell {#commands-shell}

1. Tapez `/` et sélectionnez une commande personnalisée découverte, puis fournissez ses arguments.
2. Pour une commande shell directe, tapez `!` au début d’une zone de saisie vide pour entrer en **Mode shell**.
3. Envoyez la commande. Pour quitter le mode shell sans l’exécuter, utilisez Échap, ou Retour arrière dans un champ vide.

Seuls les noms de commandes slash connus passent par le chemin des commandes personnalisées ; un `/text` inconnu est un prompt ordinaire. Les commandes personnalisées utilisent leur définition native. Les pièces jointes fichier/image ne sont pas envoyées par ce chemin et restent disponibles pour un prompt ultérieur ; le texte collé utilisé dans les arguments est résolu dans ceux-ci.

Le mode shell exécute une demande shell native de session, et ne demande pas au modèle de proposer une commande. Il peut modifier des fichiers et démarrer des processus sur l’hôte d’exécution. Les paramètres d’environnement du profil s’appliquent avant le prochain prompt, la prochaine commande personnalisée ou demande shell ; ils ne redémarrent pas un service existant. Voir [Intégrations](integrations.md) et [Configuration d’OpenCode](opencode.md).

## Orienter, mettre en file et modifier les suivis {#follow-ups}

1. Dans **Paramètres → Général**, activez **Mettre les prompts envoyés en file d’attente** pour mettre en file les suivis envoyés pendant que la session travaille ; laissez-le désactivé (par défaut) pour orienter la tâche en cours.
2. Pendant que la session travaille, envoyez un suivi avec ce comportement. Pour l’autre comportement, choisissez **Mettre le message en file d'attente** ou **Injecter maintenant** dans le menu **Plus d'actions** de la zone de saisie, ou utilisez le raccourci d’envoi alternatif (par défaut **Alt+Enter** sous Windows et Linux, **Cmd+Shift+Return** sous macOS ; voir [Raccourcis](shortcuts.md)).
3. Dans la file de prompts, utilisez **Injecter maintenant**, **Remettre en file**, **Modifier le prompt en attente** ou **Retirer le prompt en attente** tant que l’entrée est encore en attente.

| Livraison | Effet |
| --- | --- |
| Orienter | Entrée d’orientation native pour l’exécution en cours |
| Mettre en file | Suivi natif en file, conservé pour traitement ultérieur |

Au repos, un envoi ordinaire utilise le chemin immédiat normal quel que soit ce réglage, et l’alternative de **Plus d'actions** n’est pas disponible. La modification restaure un prompt en attente et ses pièces jointes retirables dans la zone de saisie ; **Annuler la modification** quitte ce mode. Un prompt déjà consommé par OpenCode n’est plus une entrée en attente modifiable. Retirer une entrée n’annule pas le travail déjà effectué.

Si une mise à jour de file échoue, inspectez la file actuelle avant de réessayer. L’admission ne prouve pas que le modèle a consommé un suivi, et une reconnexion n’autorise pas à le soumettre à nouveau.

## Poser une question annexe avec /btw {#side-question}

1. Envoyez `/btw your question` dans une conversation existante, ou `/btw` pour ouvrir la fenêtre de question annexe.
2. Lisez la réponse, utilisez **Copier la réponse**, ou choisissez **Annuler la question** pendant son attente.
3. Fermez la fenêtre une fois terminé.

C’est une demande au modèle distincte utilisant le contexte de la session. Elle n’exécute pas de boucle d’outils, n’effectue pas d’actions et n’ajoute pas sa question/réponse à la conversation. Les pièces jointes fichier/image restent dans la zone de saisie ; le texte collé utilisé dans la question est inclus comme texte. Ce n’est ni une nouvelle conversation durable ni un autre moyen de distribuer du travail.

Fermer annule la demande annexe en attente sans interrompre la session principale. Quitter la conversation active efface cette fenêtre éphémère ; copiez d’abord ce dont vous avez besoin. Les réponses vides/erreurs apparaissent ici plutôt que comme messages de transcription.

## Bifurquer, annuler et récupérer une exécution échouée {#fork-errors}

1. Sur un message, choisissez **Bifurquer après ce message** pour créer une conversation après ce point sans remplacer l’originale.
2. Pour annuler, examinez attentivement **Annuler les changements jusqu'ici (supprime les messages)**. La palette propose **Annuler le dernier message** et **Rétablir le dernier message** pour l’annulation en cours.
3. Si l’exécution échoue, consultez **Erreur de session**, l’erreur de réponse et les détails **Échec de l'envoi** avant d’envoyer à nouveau.

La bifurcation copie le contexte de conversation jusqu’au point sélectionné ; elle ne crée pas de worktree Git et n’isole pas les fichiers. Le retour en arrière n’est pas une simple navigation. Vérifiez les effets sur les fichiers et la limite d’annulation avant de continuer ; utilisez une bifurcation pour une discussion alternative sans réécrire le parcours initial.

Un statut **Nouvelle tentative** avec un compte à rebours signifie qu’OpenCode réessaie de lui-même après une erreur du fournisseur ; attendez ou arrêtez la session plutôt que d’envoyer à nouveau. Un envoi échoué restaure le brouillon et les pièces jointes tentés si cela n’écrase pas une saisie plus récente. Une exécution échouée peut déjà avoir exécuté des outils : vérifiez [Fichiers](files.md), les [demandes](permissions.md) en attente et l’activité native avant de réessayer. **Recharger les messages** ou **Recharger la session** lit l’état ; aucun des deux ne demande de répéter une modification. **Arrêter la session** interrompt l’exécution, sans annuler les changements aux fichiers ou aux services externes.
