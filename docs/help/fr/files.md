# Fichiers et Git

L’onglet **Fichiers** du panneau droit réunit la navigation dans les copies de travail, les changements locaux et l’historique des commits. Sélectionner une ligne est distinct d’ouvrir son lecteur central.

## Parcourir une copie de travail {#browse-workspace}

1. Ouvrez **Fichiers** et choisissez **Workspace**.
2. Sélectionnez **Worktree à consulter** pour changer de copie ; développez les dossiers au besoin.
3. Cliquez sur une ligne de fichier pour la sélectionner. Utilisez son œil pour ouvrir ou fermer l’aperçu central.
4. Utilisez **Actualiser** si l’instantané visible doit être revérifié.

| Mode | Lectures | Effet sur la conversation |
| --- | --- | --- |
| Workspace | Fichiers de la copie parcourue | Aucun déplacement de session ni changement de branche |
| Changements | Changements de l’index et de la copie de travail | Modifications Git uniquement par des actions explicites |
| Commits | Historique paginé des commits et contenu des révisions | Historique en lecture seule ; aucune extraction |

Les dossiers développés le restent lors des changements de mode. Les listes/statuts/historiques utilisent des instantanés en cache et sont revalidés après les changements de fichiers pertinents, à l’activation ou sur actualisation explicite ; focaliser le panneau ne garantit pas une nouvelle lecture. Les dossiers visibles du Workspace reflètent d’eux-mêmes les fichiers créés, modifiés, renommés ou supprimés sur l’hôte du backend, au plus une fois toutes les cinq secondes pendant une activité continue ; les dossiers repliés et les autres worktrees ne sont relus que lorsque vous les affichez.

Les actions de ligne incluent **Copier le chemin** et, lorsque le client peut ouvrir les chemins du backend, des actions de gestionnaire de fichiers/éditeur/terminal comme **Ouvrir avec l'application par défaut**, **Afficher dans le dossier**, **Ouvrir dans le gestionnaire de fichiers** et **Ouvrir un terminal ici**. Les actions peuvent passer dans **Plus d'actions pour {name}** si l’espace manque ; le nom du fichier ou dossier remplace `{name}`. Un navigateur distant ne peut pas supposer qu’un chemin serveur est local à l’appareil ; voir [Contrôle à distance](remote-control.md).

## Modifier le source et enregistrer sans risque {#edit-save}

1. Ouvrez un fichier texte du Workspace avec son œil.
2. Pour Markdown, choisissez **Afficher la source** pour modifier, ou **Aperçu Markdown** pour lire le rendu.
3. Modifiez et choisissez **Enregistrer**, ou appuyez sur **Ctrl/Cmd+S** lorsque l’éditeur a le focus.
4. Si le fichier a changé à l’extérieur, examinez la confirmation d’écrasement ; choisissez **Annuler** pour conserver votre brouillon sans écraser ce changement.

L’enregistrement écrit le fichier réel dans la copie parcourue, y compris un worktree lié ; il n’envoie pas de prompt et n’indexe/ne valide pas la modification. Il relit d’abord le fichier faisant autorité. Le dialogue de conflit indique **Le fichier a été modifié par l'agent. Écraser les modifications de l'agent ?** ; traitez les changements de tout auteur externe avec la même prudence.

Les brouillons source modifiés restent en mémoire du moteur de rendu par instance de projet, répertoire et chemin lorsque les lecteurs sont fermés ou changés. Les actualisations du système de fichiers ne les remplacent pas silencieusement. Ce n’est pas un stockage durable : enregistrez ou copiez les modifications importantes avant de redémarrer/recharger le client. Les échecs de lecture/écriture conservent le brouillon. **Actualiser** explicitement avertit avant d’abandonner les modifications non enregistrées.

Fermer le lecteur avec son bouton de fermeture final revient à la conversation ; la zone de saisie reste disponible sous le lecteur. Changer de session/worktree efface le lecteur sélectionné, sans promettre d’enregistrer son brouillon. Ouvrir un aperçu navigateur remplace le lecteur ; ouvrir un fichier remet cette vue en mode chat.

## Aperçus bornés et en lecture seule {#preview-limits}

1. Ouvrez une image, un fichier binaire ou un changement historique avec l’œil.
2. Pour un diff, utilisez **Passer à la vue côte à côte** / **Passer à la vue unifiée**, le retour à la ligne et les commandes des régions inchangées au besoin.
3. Fermez le lecteur pour revenir au chat.

| Contenu | Comportement disponible |
| --- | --- |
| Texte du Workspace, dont le source Markdown | Modifiable avec enregistrement explicite |
| Image du Workspace | Aperçu d’image en lecture seule |
| Autre contenu binaire | Solution de repli en lecture seule indiquant l’aperçu indisponible |
| Diff texte Changements/Commits | Comparaison en lecture seule, pas un éditeur pour l’un ou l’autre côté |
| Diff d’image Git | Images avant/après provenant exactement des révisions comparées |

Les lectures d’aperçu sont bornées ; un contenu volumineux/non pris en charge peut être indisponible plutôt que chargé sans limite. Les images historiques ne sont jamais remplacées par le fichier du worktree actuel. Un échec d’aperçu ne signifie pas que le fichier sous-jacent est absent. Ouvrez-le avec une application externe appropriée si disponible, sans changer sa révision uniquement pour obtenir un aperçu.

## Indexer, retirer de l’index et valider {#stage-commit}

1. Choisissez **Changements** et inspectez **Changements indexés** et **Changements**.
2. Utilisez **Indexer le fichier** / **Retirer de l'index**, sélectionnez plusieurs lignes pour l’action correspondante sur les fichiers sélectionnés, ou faites glisser les lignes entre les sections.
3. Saisissez un message en haut de **Changements indexés**, puis choisissez **Valider**.

Les en-têtes de sections repliées restent des cibles de dépôt. Replier les sections ou changer de mode conserve leur état et le brouillon de message de commit. Une longue section affiche ses 200 premiers fichiers, puis une ligne comme **480 fichiers non affichés** avec **Afficher 200 de plus** pour révéler les suivants sur place ; les comptes des sections restent des totaux complets, et les fichiers courant, prévisualisé et sélectionnés restent affichés. Les plages Maj+clic ne couvrent que les lignes affichées, si bien qu’une action groupée n’inclut jamais un fichier que vous ne voyez pas. L’indexation/le retrait modifie l’index du worktree parcouru ; le commit enregistre seulement le contenu indexé. Retirer de l’index n’abandonne pas la modification du worktree.

Vérifiez les fichiers indexés avant de valider, surtout si des agents ou un autre client y écrivent aussi. Un commit échoué n’est pas rejoué automatiquement. Actualisez le statut/l’historique et consultez l’erreur avant de réessayer, car une réponse perdue ne prouve pas qu’aucun commit n’a été créé.

## Lire l’historique des commits {#commit-history}

1. Choisissez **Commits** et sélectionnez un commit pour lire son message et ses fichiers modifiés.
2. Utilisez **Filtrer les commits chargés…** pour filtrer l’ensemble chargé, ou **Charger les commits précédents** pour récupérer une autre page.
3. Ouvrez un fichier modifié avec son œil.

L’historique texte compare le commit à son premier parent (ou une base vide pour un commit racine). Il ne change pas HEAD et ne déplace pas les sessions. Filtrer les commits chargés n’est pas une recherche Git log sur tout le serveur. Actualisez pour repartir de l’historique courant après de nouveaux commits ; la pagination existante conserve son instantané initial.

## Espaces et fins de ligne {#whitespace-line-endings}

1. Ouvrez **Paramètres → Avancé → Masquer les changements d'espaces**.
2. Désactivez ce réglage pour examiner les modifications non indexées portant uniquement sur les espaces, omises de Changements.
3. Vérifiez le diff réel et le contenu indexé avant de valider.

Le réglage est activé par défaut. Il masque principalement les modifications admissibles de texte suivi non indexé dans la liste Changements, les comptes, la sélection, l’indexation en masse et le glisser-déposer. Les fichiers masqués restent non indexés. Les fichiers indexés restent visibles, ainsi que les fichiers non suivis, ajoutés/supprimés/renommés et binaires. Une détection échouée/non prise en charge laisse les fichiers visibles au lieu de deviner.

La détection des listes Git peut ignorer les espaces internes, les changements CRLF seuls et l’ajout/le retrait du saut de ligne final. La comparaison des espaces du lecteur de diff est plus restreinte : indentation et espaces/tabulations de fin, pas tous les espaces internes. Indexer et Valider agissent toujours sur le contenu exact, quelle que soit la préférence d’affichage.

Les différences de fin de ligne et de marque d’ordre des octets peuvent produire une note factuelle plutôt que des lignes surlignées. Désactiver le réglage ne permet pas à l’éditeur de dessiner tout changement de fin de ligne/BOM ni tout remplacement d’espaces finaux de même longueur. Un diff visuellement vide ne prouve pas l’identité des octets.

## Initialiser Git {#initialize-git}

1. Ouvrez **Changements** ou **Commits** dans un dossier qui n’est pas un dépôt.
2. Choisissez **Initialiser Git** ; l’action est immédiate, sans confirmation.
3. Attendez l’actualisation projet/session, puis indexez et validez explicitement lorsque vous êtes prêt.

L’initialisation crée `.git` dans le dossier explicitement ouvert ; elle n’initialise pas un parent et ne crée pas de premier commit. Si Git manque sur le backend, les conversations limitées au répertoire et la navigation Workspace restent possibles, mais l’initialisation et les opérations Git sont indisponibles. En cas d’échec incertain, actualisez avant de réessayer ; aucune demande d’initialisation n’est rejouée automatiquement. Voir [Projets](projects.md).
