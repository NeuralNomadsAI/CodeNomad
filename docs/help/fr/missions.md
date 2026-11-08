# Missions

Le passage courant d’une planification quotidienne ou native utilise le même arbre de tâches paginé et les mêmes lecteurs de contenu exact. Chargez explicitement davantage de tâches ou d’activité ; les demandes non observées restent inconnues. Les lecteurs de vue d’ensemble, tâches, rapports, synthèses et changements de plan restent liés au passage sélectionné. Les résultats enregistrés conservent leurs identités de passage et de rapport lorsqu’un autre passage démarre.

Pour un champ enregistré trop volumineux, choisissez **Lire les pages JSON brutes**. **Page précédente** et **Page suivante** lisent des parties exactes et bornées ; si la collection change, **Réessayer** reprend à la première page.

Le sélecteur charge 50 résumés de mission à la fois ; **Charger davantage** poursuit la découverte. La recherche filtre uniquement les missions chargées. Seules les missions sélectionnées ou ciblées par le lecteur chargent leurs détails. Le nettoyage, l’activité et les demandes ont leurs propres compteurs et commandes **Charger davantage**. Les acteurs et demandes non lus restent inconnus, même après plusieurs fenêtres observées séparément. **Lire les champs enregistrés** donne accès aux acteurs, rapports, historiques, reçus et métadonnées par pages exactes. Une fenêtre en échec conserve son affichage ; **Réessayer** la relit, et une collection modifiée reprend à sa première fenêtre. Lire ne lance aucun travail. Les résultats historiques sont reconnus une seule fois grâce au compteur durable ; les nouvelles fins restent non vues jusqu’à leur affichage.

Les Missions associent un plan de projet durable aux conversations natives OpenCode. Le coordinateur planifie et délègue ; l’arbre des tâches enregistre dépendances et résultats. Un plan enregistré, une entrée admise et une exécution observée sont des faits différents.

## Créer, puis démarrer explicitement {#create}

1. Ouvrez **Missions** dans le panneau droit et choisissez **Créer une mission**. Le formulaire remplace l’arbre des missions jusqu’à ce que vous créiez ou annuliez.
2. Remplissez **Que doit faire la mission ?** et vérifiez **Titre**, prérempli depuis la première phrase (jusqu’à 60 caractères).
3. Laissez **Programmation** repliée pour **Une fois, immédiatement**, ou développez-la et utilisez **Ajouter un critère** sous **Lancer quand** pour ajouter des horaires ou des événements. Leur ordre fixe leur combinaison.
4. Développez **Options** pour **Scénario**, **Notes**, **Agents et modèles**, **Sessions des tâches**, la **Profondeur d’imbrication des sous-sessions** du projet, les consignes enregistrées et les conversations suivies facultatives. Avec **Comparer deux modèles**, les sélecteurs **Modèle A** et **Modèle B** apparaissent dans le formulaire principal.
5. Choisissez **Créer**. Sélectionnez l’entrée en pause, examinez-la, puis utilisez ▶ **Démarrer** lorsque vous êtes prêt. Sans critère de lancement, Démarrer lance une mission ; avec des critères, il arme la programmation native.

**Créer enregistre une Mission en pause.** Seule l’action ▶ **Démarrer** arme le travail et les calendriers natifs. La création appartient au projet/à la Location sélectionné et enregistre les profils demandés et la politique des sessions de tâches. La validation apparaît près du champ concerné ; un refus indiquant que rien n’a été envoyé conserve le brouillon pour correction. Un coordinateur ponctuel peut aussi préparer une mission de suite distincte : elle apparaît comme **Préparée** et démarre depuis sa propre action ▶.

Les missions ponctuelles enregistrées conservent leurs commandes d’exécution, leur arbre de tâches, leurs conversations et leurs rapports finaux. Les programmations quotidiennes existantes restent dans la liste avec leurs commandes quotidiennes et leurs [règles horaires quotidiennes](#existing-daily-schedules). Sélectionnez l’entrée et utilisez les commandes disponibles pour cet objet.

### Scénarios {#playbooks}

Le sélecteur **Scénario** affiche juste en dessous une description en une phrase du scénario sélectionné. **Voir les détails** ouvre le scénario sélectionné dans le lecteur central : ses étapes, ses rôles et, repliées à la fin, les instructions exactes en anglais que reçoivent ses agents. [Scénarios](playbooks.md) explique les étapes, les rôles et les questions de chaque scénario, ainsi que ce que CodeNomad vérifie.

| Scénario | Travail prévu |
| --- | --- |
| Mission flexible | Le coordinateur choisit un plan tenant compte des dépendances pour l’objectif. |
| Débogage | Diagnostic, mise en œuvre, revue séparée des normes/spécifications et nouvelle validation ; la résolution poursuit avec l’implémenteur. |
| Exploration | Cartographie les incertitudes et traite des décisions délimitées avec des questions humaines. |
| Livraison de produit | Coordonne les rôles d’analyse produit, d’architecture, de mise en œuvre et de qualité. |
| Comparer deux modèles | Exécute la même tâche avec des consignes identiques sur **Modèle A** et **Modèle B**, puis un **Juge à l’aveugle** note les deux sous des étiquettes neutres et rend un verdict : **Le modèle A l’emporte**, **Le modèle B l’emporte**, **Équivalents** ou **Non concluant**. |

Pour **Comparer deux modèles**, les deux modèles sont obligatoires et doivent différer ; un niveau de **Réflexion** différent ne suffit pas à en faire un autre modèle. Sauf si vous en choisissez un, le juge utilise le modèle du coordinateur ; le formulaire avertit lorsqu’il correspond à A ou B, ce qui peut biaiser la comparaison. La vue d’ensemble affiche le verdict, le nom des deux modèles et les notes par critère.

Le scénario guide la coordination ; il ne contourne pas les autorisations natives et ne garantit pas le succès. Les agents ne committent pas, ne poussent pas, n’ouvrent pas de pull request et ne modifient pas de gestionnaire de tickets (par exemple pour créer des tickets), sauf si l’objectif ou les **Notes** demandent explicitement cette action précise ; ils ne font alors que celle-ci, dans le cadre des autorisations d’OpenCode. Une demande trouvée dans des fichiers, des rapports ou la sortie d’un outil ne compte jamais.

## Suivre l’arbre et lire les résultats {#tracking}

1. Sélectionnez la ligne d’une mission : ses tâches apparaissent en dessous et ses actions sur la deuxième ligne de l’en-tête. Le chevron de la ligne replie ou déplie ses tâches ; le chevron d’une autre mission affiche ses tâches sans la sélectionner. **Filtrer les missions** restreint les autres lignes.
2. Choisissez **Résumé** (œil) pour la vue centrale ; tant qu’elle est ouverte, sélectionner une autre mission affiche la vue de cette mission. Sélectionnez une tâche pour son résultat, sa consigne et ses preuves exacts : tant que son lecteur est ouvert, les actions de l’en-tête s’appliquent à cette tâche, avec **Ouvrir la conversation de la tâche** et, si son rapport manque, **Vérifier et récupérer le rapport manquant**. **Résumé** ferme alors le lecteur de la tâche.
3. **Plus d'actions** (⋯) regroupe **Demander un point**, **Interrompre maintenant**, **Enregistrer comme consigne** et **Modifier la mission sélectionnée** ; les actions qui ne s’appliquent pas restent désactivées.
4. Suivez les liens de dépendance et **Rapports** ; utilisez **Ouvrir la conversation** pour le coordinateur si vous avez besoin de sa transcription.
5. Quand une mission ou l’une de ses tâches passe au rouge, sélectionnez-la : la conversation qui pose la question s’ouvre, avec cette question dans le dock d’interruption.

| Indicateur | Ce qu’il établit |
| --- | --- |
| Assignée | Une entrée a été admise ; la consommation par le modèle/le travail/la fin ne sont pas prouvés. |
| En cours | Une activité native a été observée. |
| En attente | Les dépendances déclarées ne sont pas encore satisfaites. |
| Bloquée | Un blocage a été signalé, pas nécessairement une question pour vous. |
| Attend votre réponse | Un Form/une question ou autorisation native ouverte attend une réponse ; sélectionnez la tâche pour l’ouvrir. |
| Terminée | Un résultat de tâche a été enregistré ; vérifiez ses preuves et le travail natif restant. |
| Échec / Retirée | La tâche a échoué, ou le coordinateur l’a remplacée ou abandonnée. |

Le graphe inclut les travaux terminés et retirés. Retirer une tâche n’arrête pas en soi sa conversation. Dans une mission ponctuelle, le coordinateur peut arrêter séparément les conversations d’une tâche retirée qu’il a lancée comme sous-agent natif, sans toucher aux autres tâches. **En cours** est l’état du cycle de vie de la mission, pas une preuve que son coordinateur travaille actuellement. Les textes complets se lisent dans le lecteur central, pas dans la liste des tâches ; **Détails techniques** replie les identifiants et les informations d’exécution demandées.

Un grand plan forme un arbre continu : les tâches suivantes se chargent au défilement, avec un seul bouton **Afficher plus** en fin de liste. Les épingles existantes restent visibles ; tant que certaines se trouvent plus bas, l’icône d’info de la ligne **Tâches**, au-dessus des tâches, donne les nombres de tâches demandant votre attention par type dans toute la mission. Les compteurs de chargement et les explications de couverture sont derrière les icônes d’info. Les lectures de fond animent l’indicateur **Actualiser** existant en haut à droite, sans déplacer le panneau. Un trait en pointillé signale une dépendance ou une tâche dépendante non chargée ; les liens du lecteur chargent directement leur cible. Le lecteur propose **Tout afficher** pour les résultats antérieurs et **Réessayer** après un échec de lecture.

Les pages de tâches ne s'affichent qu'une fois entièrement reçues. Une lecture échouée ou modifiée conserve les dernières tâches affichées. Si la liste change pendant la lecture, utilisez **Actualiser**, puis **Réessayer** ; la page est relue depuis le début. Une partie manquante ne prouve jamais l'absence d'une tâche ou d'une demande, et réessayer une lecture ne lance aucun travail. Si le plugin Missions ne peut pas fournir la page, réessayez après reconnexion ou rechargement du plugin.

### Couleurs et missions interrompues {#status-colours}

Les drapeaux des missions et les icônes des tâches reprennent les couleurs de la liste des sessions : la couleur ne montre que ce qui vous attend maintenant. Une mission récurrente affiche une icône de répétition à la place du drapeau.

| Couleur | Signification |
| --- | --- |
| Rouge | Une réponse de votre part est attendue. Le drapeau d’une mission passe au rouge pour une question de son coordinateur, une tâche pour la sienne, et le chevron de la mission signale qu’une de ses tâches pose une question. Sélectionnez la mission ou la tâche en rouge pour ouvrir la question. |
| Jaune, pulsant | Un travail est en cours. |
| Orange | La mission est en pause ou interrompue, avec une action pour la poursuivre. |
| Vert | Une mission terminée que vous n'avez pas encore ouverte dans cette fenêtre ; elle redevient neutre dès que vous la sélectionnez. |
| Bleu | Une mission préparée, prête à démarrer comme un prompt rédigé. |

Tout le reste est neutre, y compris les tâches terminées ou en échec : les résultats figurent dans le texte d'état et les icônes.

Une mission est **Interrompue** quand son coordinateur s'est arrêté sans conclure alors que rien d'autre ne tourne. Une mission affichée **Échouée** peut aussi être reprise. Dans les deux cas, le premier bouton de la barre d'outils devient **Reprendre la mission interrompue** : il demande au coordinateur de refaire le point à partir du plan et des résultats enregistrés, et rouvre d'abord une mission échouée. Un coordinateur ne termine pas une mission ponctuelle en échec : quand plus rien ne peut avancer sans vous, il vous pose une question et sa ligne passe au rouge. Vous seul arrêtez une mission.

### Questions et décisions {#questions}

Seul le coordinateur vous pose des questions. Les tâches et les sous-agents qu’elles lancent lui renvoient leurs questions ouvertes, avec les options, les éléments à l’appui et une recommandation. Avant de demander, le coordinateur essaie de trancher lui-même : il lit le projet, fait des recherches, confie une investigation à une tâche, ou adopte un choix par défaut facile à défaire qu’il consigne comme hypothèse. Il ne demande que ce qu’il ne peut pas trancher : votre accord, des identifiants, des choix coûteux à défaire ou des décisions produit que l’objectif laisse ouvertes. Il regroupe les questions en attente dans un seul formulaire, ouvert depuis la ligne rouge de la mission, et lance d’abord le travail sans rapport.

Dans **Exploration**, les tâches de décision préparent une synthèse et le coordinateur tranche chaque décision : il décide lui-même quand les éléments suffisent et que le choix est facile à défaire, garde la question dans les **Notes** pour plus tard, ou vous la pose. Avec **Sous-agents natifs**, le résultat de la tâche de décision indique qui a décidé :

| Libellé | Signification |
| --- | --- |
| **Décision du coordinateur** | Le coordinateur a décidé sans vous demander ; le résultat montre sa justification et les éventuelles indications pour revenir dessus qu’il a fournies. Pour la modifier, écrivez au coordinateur depuis **Ouvrir la conversation**. |
| **Votre réponse** | Vous avez répondu à cette question dans le dock d’interruption de CodeNomad. |

Seule une réponse donnée dans le dock d’interruption compte comme **Votre réponse** ; un agent ne peut pas répondre à votre place. Avec **Sous-agents natifs**, chaque question de décision se termine par l’étiquette de la seule décision qu’elle tranche, par exemple `[decision choose-seam 3fa9c21b]`. Quand plusieurs décisions sont demandées ensemble, chacune forme une question distincte avec sa propre étiquette ; une question qui nomme deux décisions n’en tranche aucune. Avec **Sessions indépendantes**, le coordinateur consigne plutôt chaque issue dans les **Notes**, en précisant qui, de lui ou de vous, a décidé. Dans **Livraison produit**, un objectif qui décrit déjà précisément le changement de comportement vaut spécification approuvée ; sinon, le coordinateur vous demande de l’approuver, en regroupant les approbations en attente.

### Points de situation et demandes de mise à jour {#briefings}

Le coordinateur reçoit l’instruction de publier un point sur le projet après son plan initial, après le règlement des tâches, lorsqu’il attend un humain et avant le rapport final. Il s’agit d’une évaluation rédigée, pas d’un compteur d’activité en direct ni d’un signal périodique garanti. Un avis indique si le plan a changé depuis ce point.

Utilisez **Demander un point** sous **Plus d'actions** (⋯) pour une nouvelle évaluation du coordinateur, puis lisez **Résumé**. **Point demandé…** signifie que la demande attend, pas qu’elle a reçu une réponse. **Envoi non confirmé** n’autorise pas le renvoi automatique : ouvrez la conversation du coordinateur avant de faire une nouvelle demande séparée. C’est une entrée native ordinaire, pas un bac à sable en lecture seule ; le coordinateur conserve ses autorisations normales.

## Comment le contexte circule dans une mission {#context-flow}

Le plan de mission est la mémoire partagée et durable de la mission. Il contient l’objectif et les **Notes**, chaque tâche avec son **Brief de tâche**, ses dépendances (**Dépend de**) et son état, les **Rapports** enregistrés pour le travail terminé (résumé, **Preuves**, **Prochaines étapes recommandées** et éventuel **Rapport structuré**), les points de situation du coordinateur et les **Modifications du plan**. OpenCode le stocke avec le projet : il survit donc aux conversations et aux redémarrages ; le centre de mission l’affiche, et la récupération repart de lui. Chaque participant en reçoit une partie définie :

| Participant | Ce qu’il reçoit |
| --- | --- |
| Coordinateur | L’objectif, les notes et les instructions du scénario à chaque tour. Il lit le plan entier chaque fois qu’il en a besoin ; sa conversation enregistrée conserve chaque résultat qu’il a lu, tandis qu’OpenCode peut [compacter](history.md#compact-session) son contexte de modèle. |
| Tâche (**Sous-agents natifs**) | Son affectation, transmise par le coordinateur dans un appel de sous-agent OpenCode ordinaire : l’objectif, le titre et la consigne de la tâche, les instructions de son rôle et les tâches dont elle dépend. Le coordinateur peut y ajouter du contexte, comme des résultats antérieurs. |
| Tâche (**Sessions indépendantes**) | La même affectation, sous forme de message dans sa propre conversation. À chaque tour, elle reçoit aussi l’objectif, les notes et ses affectations ouvertes, et elle peut lire le plan entier. |
| Assistants lancés par une tâche | Ce que leur parent écrit dans l’appel. Les scénarios demandent à chaque parent de transmettre le périmètre, les contraintes et les règles de sécurité dont ses assistants ont besoin. |

Les résultats remontent par le même chemin. Un sous-agent natif renvoie son résultat à la conversation qui l’a lancé, normalement le coordinateur, qui l’enregistre comme rapport de la tâche. Une session indépendante enregistre son propre rapport, et CodeNomad remet son résumé au coordinateur sous forme de message.

Une tâche ultérieure s’appuie sur le travail antérieur de deux façons. Les dépendances ordonnent le travail : le coordinateur démarre une tâche une fois terminées les tâches dont elle dépend, puis place les résultats utiles dans la consigne ou à côté de l’affectation ; les sessions indépendantes peuvent aussi lire ces rapports dans le plan. Pour poursuivre la conversation même d’une tâche terminée, le coordinateur déclare une tâche de suite qui la réutilise : la suite y continue avec le contexte actuel de cette conversation, qu’OpenCode a pu [compacter](history.md#compact-session), tandis que les détails antérieurs restent dans son historique enregistré pour la recherche. Le scénario Débogage renvoie ainsi les deux revues à l’implémenteur. Avec **Sessions indépendantes**, le coordinateur peut aussi affecter une tâche à une conversation principale existante, qui conserve son propre contexte, y compris un travail antérieur sans rapport. Sinon, une tâche démarre dans une nouvelle conversation à partir de son affectation, et la transcription d’une autre tâche lui parvient par le coordinateur ou par une recherche. Pour **Comparer deux modèles**, l’affectation et le contexte du juge omettent l’objectif et les notes ; sa consigne contient les résultats anonymisés.

Chaque passage programmé démarre avec son propre coordinateur et son propre plan de mission, à partir des instructions enregistrées et des entrées figées. Les conversations suivies apportent une quantité bornée de nouveau texte utilisateur et assistant ; leurs curseurs de consommation avancent après un passage réussi. Les passages précédents restent dans l’historique de la programmation. Les conversations lancées pendant un passage peuvent lire son plan. Une nouvelle mission ponctuelle possède un plan distinct : placez les résultats à transmettre dans son objectif ou ses **Notes**, ou demandez au coordinateur de préparer une suite avec ce contexte.

### Rechercher dans les conversations antérieures {#context-search}

Tant que CodeNomad fonctionne, chaque conversation d’agent du projet, coordinateurs de mission et tâches compris, dispose de l’outil de recherche de sessions de CodeNomad (`codenomad.session_search`, utilisé via le Code Mode d’OpenCode). Il recherche dans les conversations enregistrées du dossier de projet de la conversation avec le même classement que la [recherche](history.md#full-history-search) **Workspace entier**, et renvoie de courts extraits avec le titre et l’identifiant de chaque conversation, ainsi qu’un moyen de lire une conversation entière. Les autorisations natives des outils s’appliquent. Un agent cherche lorsqu’il le décide ou lorsque l’objectif, les notes ou votre message le lui demandent, par exemple pour retrouver ce qu’a conclu une mission ou une tâche antérieure. Un passage programmé exécuté pendant que CodeNomad est fermé travaille sans cet outil.

## Profils, délégation et profondeur {#profiles}

Enregistrer une profondeur préserve les programmations natives activées dans la configuration du projet. Un `schedules:false` explicite du projet reste désactivé ; retirer la profondeur conserve le réglage de programmation. Les fichiers JSON et JSONC concurrents doivent être départagés avant d’enregistrer les réglages natifs.

1. Utilisez l’engrenage des Missions ou **Paramètres → Missions** pour modifier **Défauts des nouvelles missions**.
2. Sous **Appliquer à**, choisissez **Toutes les missions** ou un scénario, puis réglez **Sessions des tâches** et, sous **Agents et modèles**, une ligne par rôle (coordinateur, puis les rôles du scénario). Chaque choix est enregistré immédiatement ; il n’y a pas de bouton Enregistrer.
3. Dans la portée d’un scénario, les lignes affichent les valeurs globales marquées **Global**. Modifier un champ personnalise ce rôle à partir de ces valeurs ; son icône de retour réutilise les valeurs globales. **Réinitialiser** (après confirmation) efface seulement les agents et modèles de la portée affichée.
4. À la création, utilisez **Options → Agents et modèles** pour des profils demandés spécifiques ; **Utiliser les réglages enregistrés** rétablit ceux qui sont enregistrés.
5. Pour les limites de récursion native, modifiez **Profondeur d’imbrication des sous-sessions → Profondeur imposée pour le projet**, ici ou sous **Options** à la création. Appuyer sur Entrée ou quitter le champ enregistre une valeur valide modifiée ; **Hériter** enregistre aussitôt ; Échap abandonne une valeur non enregistrée.

| Réglage | Portée et effet |
| --- | --- |
| Défauts des nouvelles missions | Valeurs par défaut de la configuration pour les **nouvelles** missions seulement ; une exception de scénario remplace la valeur générale. |
| Agent / Modèle / Réflexion | Sélections demandées du coordinateur/des rôles enregistrées à la création ; un acteur occupé ne change pas silencieusement pour un travail ultérieur. Les passages programmés utilisent leurs profils demandés enregistrés ; les modifications s’appliquent aux futurs passages. |
| Sous-agents natifs | Les sessions de tâches utilisent les agents natifs subagent/all sous le coordinateur. |
| Sessions indépendantes | Les sessions de tâches déclarées utilisent les agents primary/all et des conversations indépendantes ; cela ne désactive pas les assistants natifs internes. |
| Profondeur d’imbrication des sous-sessions | Configuration de projet pour **toutes** les conversations OpenCode qui s’y trouvent, pas seulement les Missions. Vide hérite : **Hériter** supprime le remplacement du projet ainsi qu’un bloc `experimental` qu’il laisse vide ou qui ne contient plus que la valeur globale de **Stocker les images une seule fois**. OpenCode lit le bloc `experimental` du projet comme un tout ; les autres réglages expérimentaux qui y restent masquent donc toujours la profondeur globale. Par défaut, le sous-agent intégré **General** d’OpenCode ne peut pas lancer de sous-agents, donc ses conversations ne s’imbriquent jamais : enregistrer une profondeur de projet, quelle qu’elle soit, ajoute aussi au même fichier une règle qui permet aux sous-agents de lancer leurs propres sous-agents jusqu’à cette profondeur et qui prime sur les restrictions de General venant d’autres fichiers de configuration (à une profondeur de 1, la limite de profondeur d’OpenCode empêche toujours l’imbrication), et **Hériter** la retire. Sous **Profondeur OpenCode effective**, l’éditeur indique si les sous-agents General peuvent s’imbriquer. Si le projet définit General dans l’ancien format avec une valeur `permission` unique, ou avec `task` et `subagent` déjà définis, seule la profondeur est enregistrée et l’éditeur le signale : autorisez vous-même les sous-agents pour General dans ce fichier. L’enregistrement ne recharge pas OpenCode et ne change pas les conversations actives. |

**Valeur native par défaut** et **Global** diffèrent : le premier demande les valeurs par défaut propres à OpenCode, le second hérite du choix global ; choisir les valeurs natives par défaut dans la portée d’un scénario reste une exception explicite. La disponibilité du catalogue est vérifiée ; un profil demandé ne prouve pas celui qu’utilise actuellement une conversation. Les autorisations natives et la profondeur configurée régissent toujours les appels d’assistants internes dans les deux modes de tâches.

Chaque liste **Modèle** affiche ce qu’affiche le sélecteur **Modèle** de la conversation, sous les mêmes noms et groupé par fournisseur : les modèles masqués en sont exclus et, tant que le filtrage limité aux favoris est actif, les autres modèles aussi (voir [Visibilité des modèles, favoris et Réflexion](providers.md#models)). Les modèles sans prise en charge des outils sont également exclus. Un modèle enregistré absent de la liste reste sélectionné. **Indisponible** signale un modèle enregistré que le sélecteur ne peut pas proposer actuellement : il est absent du catalogue actuel du projet, obsolète ou sans prise en charge des outils.

Un choix refusé ou non confirmé n’est jamais renvoyé : les valeurs enregistrées sont réaffichées, et **Recharger** n’apparaît que lorsqu’elles ne peuvent pas être lues. Si un changement de profondeur n’est pas confirmé, votre valeur est conservée ; utilisez **Actualiser la profondeur du projet** avant un autre changement. N’interprétez pas **Profondeur OpenCode effective inconnue** comme zéro ou désactivée.

## Réutiliser une consigne enregistrée {#saved-briefs}

1. À la création, développez **Options → Partir d’une consigne** et sélectionnez la consigne enregistrée.
2. Vérifiez l’objectif, les notes, le scénario, les profils et la délégation copiés avant **Créer**.
3. Utilisez **Enregistrer comme consigne** pour nommer un brouillon réutilisable. Une mission ponctuelle sélectionnée, même terminée, propose aussi **Enregistrer comme consigne** sous **Plus d'actions** (⋯).

Les consignes stockent les instructions et choix demandés, pas les plans de tâches, résultats, conversations, horaires de programme ou autorité d’exécution. En charger une remplit un brouillon de création ordinaire ; cela ne démarre ni ne planifie rien. Retirer une consigne conserve les missions/conversations existantes. **Paramètres → Missions → Consignes enregistrées** gère la bibliothèque ; si celle-ci devient illisible, **Réinitialiser la bibliothèque enregistrée** (après confirmation) retire les consignes enregistrées, pas les exécutions. Les programmes eux-mêmes n’ont pas d’action d’enregistrement comme consigne.

## Programmation, rattrapage et conversations suivies {#daily-schedules}

### Programmation native {#native-scheduling}

Les icônes **i** près des libellés expliquent les choix : survolez-les, placez-y le focus au clavier ou touchez-les.

Développez **Programmation** dans le formulaire de création ou de modification. **Lancer quand** liste les critères qui lancent la mission : choisissez **Ajouter un critère**, puis son type. Sans aucun critère, elle part une fois au démarrage (**Une fois, immédiatement**). Retirez un critère avec son bouton ×. L’**i** à côté de **Lancer quand** s’ouvre au clic, avec Entrée ou Espace : il explique **si** et **sinon**, rappelle que la mission ne tourne que si OpenCode tourne et mène au [réglage de démarrage d’OpenCode](opencode.md#login-start). Les nouvelles programmations utilisent le fuseau du système ; **Fuseau enregistré (IANA)** n’apparaît que si le fuseau enregistré en diffère.

| Horaire | Déclenchement |
| --- | --- |
| Toutes les N heures | Toutes les 1, 2, 3, 4, 6, 8 ou 12 heures, à l’heure pile, dans le fuseau enregistré. |
| Tous les jours | Une heure civile dans le fuseau enregistré. |
| Certains jours de la semaine | Une heure les jours cochés. |
| Un jour de chaque mois | Le jour 1–31 à l’heure choisie ; les mois dépourvus de ce jour sont sautés. |
| Avancé (cron) | Une expression cron native, au plus une fois par minute. |

Ajoutez plusieurs horaires pour plusieurs heures, comme 09:15 et 17:45. Chacun est un cron ; les expressions reconnues se rouvrent sous leur raccourci. Les [événements](#scheduling-conditions) sont les autres critères : les événements qui lancent la mission sont vérifiés toutes les 15 minutes, sans fréquence à régler ; les conditions sont lues aux moments qui en ont besoin.

Entre deux cartes, un petit connecteur indique comment elles se combinent : **ou** entre deux horaires ou deux événements, **si** d’un horaire vers un événement, **sinon** d’un événement vers un horaire. Les événements en tête lancent la mission chaque fois qu’ils se produisent ; les horaires en tête la lancent à leurs heures. Les événements placés après des horaires sont leurs conditions : à chacune de ces heures, la mission ne part que si l’un d’eux s’est produit depuis le dernier passage réussi ; sinon cette heure est sautée. Les horaires placés après des événements sont un repli pour tout ce qui est au-dessus : à chacune de ses heures, un horaire de repli ne lance que si les cartes au-dessus de lui n’ont lancé aucun passage depuis son heure précédente (ou depuis sa mise en place) ; un **Lancer maintenant** compte aussi, tout comme un passage échoué. Les événements placés après lui conditionnent seulement ce repli. Par exemple, nouveaux commits, puis 18:00, puis nouveaux messages, puis 20:00 lance à chaque commit ; sinon à 18:00 s’il y a eu de nouveaux messages ; sinon à 20:00. Faites glisser une carte par sa poignée pour changer l’ordre, ou placez le focus sur la poignée et appuyez sur Alt+Flèche haut ou Alt+Flèche bas ; les connecteurs suivent.

Un passage en cours n’est jamais doublé. Les horaires ou événements survenus pendant qu’il tourne sont regroupés en un seul passage, lancé à sa fin, s’ils auraient lancé la mission à leur propre heure : leurs conditions et replis sont alors décidés.

Les horaires civils suivent le fuseau enregistré et les règles de changement d’heure d’OpenCode. Un calendrier sans aucun créneau futur est refusé.

Après une panne, la programmation native livre au plus un passage de rattrapage avant de revenir aux créneaux futurs. Elle utilise le créneau natif dû enregistré, qui peut précéder d’autres créneaux manqués. Tous les horaires partagent ce rattrapage et la même protection contre le chevauchement. Un passage non résolu est réconcilié avec ses identités de conversation et de message d’origine avant qu’un autre puisse démarrer. Reprendre une programmation explicitement mise en pause utilise son prochain créneau futur.

### Événements et sources {#scheduling-conditions}

Un critère d’événement désigne sa source dans ce projet : **Réussite d’une autre programmation**, **Nouveaux commits sur une branche locale**, **Réussite d’une Mission unique**, **Nouveau message dans une conversation suivie** ou **Modification de fichiers explicites**. Plusieurs événements peuvent être listés, y compris deux branches ; un seul suffit. Chaque nouveau changement admissible peut relancer la mission.

Le premier démarrage établit la référence initiale. La reprise la conserve, y compris les changements observés après une pause. Les sources de réussite exigent un résultat réussi vérifié et une famille native dont l’exécution est réglée. Les vérifications de branche utilisent les commits locaux et leur ascendance sans récupération distante. Celles de conversations attendent des messages nouveaux complets et stables et excluent les réveils techniques et les conversations du passage lui-même. Les fichiers utilisent jusqu’à 128 chemins explicites relatifs au projet, un par ligne ; les motifs récursifs et les chemins liés sont refusés. Une source absente, déplacée, ambiguë ou dépassant la capacité bloque l’admission avec une explication. Pour être détectés, les changements entre vérifications doivent laisser une trace durable dans la source.

Les changements observés ensemble sont regroupés. Un passage fige les preuves observées dans la source ; un règlement réussi consomme cet instantané, laissant les changements ultérieurs pour une prochaine vérification. Un passage échoué conserve son point de contrôle de source et exige une intervention. **Conversations suivies (facultatif)** sous **Options** fournit du contexte indépendamment du choix d’un événement de message de conversation.

### Décomptes et programmations enregistrées {#scheduling-limits}

Les programmations n’ont pas de date de fin. Une programmation enregistrée avec une date de fin continue de la respecter jusqu’à ce que vous la modifiiez ; enregistrer une modification retire la date de fin. Un créneau enregistré avant cette fin peut arriver tardivement après une longue panne. Un passage déjà admis reste observable jusqu’à son résultat.

**Passages lancés** compte chaque passage une fois dès l’admission de la première entrée de son coordinateur, y compris **Lancer maintenant** et un passage qui échoue ensuite. Les vérifications, les événements inchangés et les réveils refusés ne comptent pas. Les décomptes sont conservés après modification ou redémarrage.

Une programmation enregistrée avec une fréquence et une condition facultative s’ouvre sous forme de critères : la fréquence devient des horaires placés en premier, une condition après une fréquence est placée après eux et devient leur condition (**si**), et une condition seule devient l’événement qui lance la mission ; la rouvrir et l’enregistrer sans changement conserve exactement la programmation enregistrée, y compris un lancement unique sur cet événement ; enregistrer une modification retire cette limite de lancement unique, et l’événement lance alors la mission chaque fois qu’il se produit. Un intervalle, un délai, une date unique, un nombre maximal de passages ou une fin après un nombre d’heures continue de fonctionner tel qu’enregistré et s’affiche sous **Politique de lancement enregistrée** jusqu’à son remplacement.

La programmation native sélectionnée affiche **État voulu**, **Calendrier natif**, **Prochain réveil** ou **Prochaine vérification**, **Vérifications** avec **Suivi depuis le…**, **Passages lancés**, **Passages réussis**, sa fin et **Exécutions passées**. Lisez un ancien passage via **Ouvrir la conversation**. **Programmation terminée** décrit la fin de la programmation ; inspectez séparément le résultat du passage. Les résultats conservent les 30 dernières entrées ; les totaux cumulés persistent au-delà de cette fenêtre. **Charger d’autres Missions** charge la page suivante d’objets enregistrés.

La liste résume chaque critère dans l’ordre, précédé après le premier de son connecteur (**ou**, **si** ou **sinon**) ; le détail n’affiche une date de fin enregistrée que si elle est définie, et **Vérifications** seulement avec des événements.

### Programmations quotidiennes existantes {#existing-daily-schedules}

Les programmations quotidiennes existantes utilisent le fuseau IANA et l’heure civile enregistrés. Chaque exécution possède son propre coordinateur et son propre plan de mission ; sélectionnez son arbre actuel ou une date/un résultat passé pour le lire au centre. Leur historique conservé contient 30 résultats. Les règles quotidiennes suivantes s’appliquent à ces entrées :

| Situation | Comportement de planification |
| --- | --- |
| Plusieurs jours d’échéance manqués | Exécute uniquement le dernier jour dû postérieur au marqueur quotidien réglé, pas une file pour chaque jour manqué. |
| Saut à l’heure d’été | Avance à la première minute valide suivante ; un saut en fin de journée franchit la limite du jour. |
| Heure répétée | Utilise la première occurrence ; ne crée pas une seconde exécution quotidienne. |
| Jour civil entièrement sauté | Aucune exécution n’existe pour ce jour. |
| Horloge reculée | Ne rend pas de nouveau dû un jour déjà traité. |
| Exécution existante encore en attente | Ne la fait pas chevaucher une nouvelle exécution quotidienne. |

La date de création borne aussi le travail quotidien admissible. **Lancer maintenant**, lorsque proposé pour une entrée quotidienne existante, lance une exécution manuelle distincte sous la protection contre les exécutions en attente et conserve son horloge quotidienne. L’heure suivante affichée est une projection soumise à la disponibilité du service et de l’hôte.

**Conversations suivies (facultatif)** ajoute un contexte borné des conversations choisies. Seule une exécution terminée avance leurs curseurs de messages traités ; une exécution échouée/interrompue ne consomme pas silencieusement ce contexte. Si les instructions et le contexte dépassent la capacité, raccourcissez les instructions ou retirez des conversations suivies au lieu de supposer qu’un historique illimité est lu.

## Durée de vie et redémarrages du service {#lifetime}

Le **i** près de **Détails techniques** explique l’activité technique et les coûts.

Pour une programmation native, développez **Détails techniques** pour identifier son **Porteur principal** et son **Porteur de réconciliation**, leurs calendriers natifs et tout **Nettoyage en attente de réconciliation**. Ces conversations techniques n'ont pas d'action de composition et restent absentes des sélecteurs ordinaires de conversations et de sources. Les réveils techniques, les titres et la compaction utilisent le modèle local sans requêtes HTTP vers les fournisseurs ; les événements et statistiques natifs peuvent quand même les inclure, tandis que les passages effectifs conservent leurs coûts de modèle habituels. La compaction borne le contexte traité en conservant l'identité de la conversation et du calendrier. Les messages et événements natifs stockés peuvent s'accumuler jusqu'au nettoyage explicite d'une programmation terminée ; les 30 résultats de Mission conservés sont distincts. Le réglage de profondeur affiche le chemin sous **Fichier de configuration OpenCode :** lorsqu’il est disponible et indique séparément sa **Cible d’écriture du projet**.

| Composant | Ce que signifie sa fermeture |
| --- | --- |
| Onglet de projet CodeNomad | Ferme le projet dans CodeNomad ; les sessions natives continuent dans OpenCode. Rouvrez le projet pour les retrouver. |
| Fenêtre entière, fermeture de l’application ou rechargement du moteur de rendu | Conserve les connexions de projet pour la restauration ; n’arrête pas le travail natif ni le service OpenCode. |
| Backend CodeNomad | N’arrête pas OpenCode. Une mission ponctuelle en cours continue : son coordinateur, ses tâches en sous-agents natifs et les outils de mission fonctionnent dans OpenCode. L’affectation de tâches à des sessions indépendantes et la remise de leurs rapports au coordinateur, les missions que prépare le coordinateur, l’arrêt des conversations d’une tâche retirée, la récupération et le centre de mission attendent le backend, tout comme la poursuite d’une mission ponctuelle après un redémarrage du service OpenCode. |
| Programmation native armée | Les calendriers persistants d’OpenCode réveillent leur projet et exécutent les passages avec l’interface et le backend CodeNomad fermés, tant que l’hôte d’exécution et le service sont disponibles. |
| Redémarrage du service OpenCode — programmation native saine | Une programmation saine dont l’état voulu est en marche reprend automatiquement son calendrier. Le travail en attente est réconcilié avec ses identités d’origine avant toute nouvelle admission. |
| Programmation quotidienne existante | Son horloge de plugin fonctionne avec CodeNomad fermé tant que le service reste actif. Un redémarrage du service la laisse **Interrompue** ; **Reprendre** explicitement réconcilie l’exécution en attente et réarme son horloge quotidienne. |

Pour les programmations natives, une pause ou un arrêt explicite, un travail échoué et un résultat incertain conservent leurs barrières d’admission après redémarrage. Inspectez le passage conservé et la requête d’origine ; utilisez **Vérifier le passage** ou **Actualiser la requête enregistrée** lorsque proposé, puis **Reprendre** seulement quand l’état le permet. Une continuation native est observée avec son identité existante. Un échec prouvé ou une fin sans rapport exige une récupération humaine ; des preuves incomplètes gardent le passage incertain. N’utilisez jamais un redémarrage pour réessayer des effets d’outils engagés.

Les Missions fonctionnent avec les applications de bureau et avec un [serveur](server.md) CodeNomad autonome. Lorsque le panneau affiche **Le centre de mission est indisponible**, son message en nomme la cause :

| Cause | Que faire |
| --- | --- |
| L’espace de travail OpenCode n’est pas prêt | Reconnectez le projet, puis actualisez. |
| OpenCode n’a pas chargé le plugin Missions | Actualisez dans un instant ; si cela persiste, utilisez **Recharger la configuration OpenCode** dans **Paramètres → OpenCode**. |
| OpenCode n’a pas pu charger le plugin Missions | Lisez son erreur dans la liste des plugins, puis actualisez une fois le problème corrigé. |
| Le serveur CodeNomad n’a pas pu ouvrir sa connexion locale pour les Missions (127.0.0.1) | Consultez le journal du serveur ; recharger OpenCode n’y change rien. |

## Pause, arrêt et résultats incertains {#controls-recovery}

1. Sélectionnez l’entrée et inspectez son état actuel et sa conversation avant d’agir.
2. Utilisez l’icône de pause pour une suspension reprenable, ou celle d’arrêt et sa confirmation pour un arrêt terminal. Les infobulles ponctuelles sont **Mettre la mission en pause** et **Arrêter définitivement la mission** ; celles des programmes nomment le programme.
3. Si le résultat n’est pas confirmé, utilisez **Vérifier l’état** / **Vérifier l’état du contrôle** pour lire le résultat existant. Ne lancez pas d’action de remplacement pour contourner l’incertitude.
4. Pour les actions ponctuelles, **Actualiser et renvoyer l’action non confirmée** dans l’en-tête vérifie d’abord l’état et ne renvoie que cette action exacte encore non confirmée, depuis votre clic explicite.

La pause ponctuelle laisse finir le travail en cours : le coordinateur et ses sous-agents terminent l'étape en cours, ne lancent rien de nouveau puis s'arrêtent, pendant que le panneau affiche **Mise en pause : les étapes en cours se terminent.** **Interrompre maintenant** les arrête au contraire tout de suite : cela interrompt la famille native de la mission et suspend la coordination. L'arrêt interrompt aussi, annule les entrées/livraisons familiales en file et est terminal. Ces interruptions sont bornées : **Certains sous-agents sont peut-être encore actifs.** signifie que l'une d'elles est incomplète. Inspectez le résultat conservé et utilisez son nouvel essai explicite au lieu de supposer que tous les effets shell/outils ont été annulés. La reprise informe le coordinateur de ce qui a été mis en pause ou interrompu ; il décide comment poursuivre.

Pour une programmation native, **Pause** ferme les futures admissions et demande l’interruption d’un passage admis ; **Reprendre** réconcilie le travail existant avant de réarmer. **Arrêter…** est terminal. **Lancer maintenant** utilise la même protection contre les passages en attente tout en conservant les créneaux des horaires. **Vérifier le passage** réconcilie le passage d’origine. Conservez une action non confirmée et utilisez **Actualiser la requête enregistrée** ; l’actualisation passive et la reconnexion conservent cette requête. Les effets d’outils engagés peuvent continuer après interruption.

Après confirmation d’une action, les autres actions et **Modifier la mission sélectionnée** restent désactivés jusqu’à ce qu’une vue actualisée et validée intègre ce changement ou une révision ultérieure. Fermer puis rouvrir le panneau conserve cette attente. **Actualiser la requête enregistrée** actualise alors seulement l’affichage. Si cette lecture échoue, l’action reste confirmée ; utilisez le même bouton pour relire.

Les entrées quotidiennes existantes conservent leurs commandes quotidiennes Pause/Arrêter/Reprendre/Lancer maintenant/Vérifier le passage. Pause/Arrêter annulent leur horloge et demandent l’interruption des racines enregistrées, dont les spécialistes indépendants. Inspectez leurs familles natives et tout résultat d’interruption partielle. Les échecs transitoires de vérification quotidienne sont réessayés avec leur avertissement affiché ; une réponse perdue à une commande utilisateur reste rattachée à sa requête d’origine. Une entrée arrêtée reste dans un état terminal.

Pour un coordinateur ponctuel inactif sans rapport, l’action principale ▶ peut le vérifier et le récupérer ; les tâches disposent d’une récupération ciblée de rapport manquant si admissible. La récupération vérifie d’abord l’activité native, les descendants et les attentes ; une activité inconnue refuse l’admission. Elle ne rejoue pas les affectations et ne remplace pas le plan. Ouvrez les conversations pour résoudre les questions, autorisations, shells ou travaux en arrière-plan restants.

Si **Créer** n’est pas confirmé, la fenêtre conserve la demande soumise et désactive toute autre création pour ce projet ; la suppression de worktree peut rester bloquée. Actualiser lit seulement l’état. Fermer/rouvrir l’éditeur ne répare pas cela. Avant de recharger la fenêtre, inspectez la liste des missions : recharger efface le verrou local, **sans prouver que la création a échoué**. Ne créez pas aveuglément un doublon après un rechargement ou redémarrage.

## Modifier, supprimer et nettoyer les conversations {#cleanup}

Si l'objectif ou les notes changent pendant le chargement du formulaire, il indique que la mission a changé depuis son ouverture au lieu de les remplir ; choisissez **Rouvrir** pour modifier la version actuelle.

Entre les passages, une programmation native en pause ou en marche permet de modifier titre, instructions, notes, profils demandés, mode des sessions de tâches et critères de lancement quand aucun passage ni aucune commande non résolue ne retient l’objet. Une programmation en pause reste en pause ; une programmation armée réconcilie son calendrier avant de continuer. Enregistrer conserve les résultats passés, les sources consommées, le nombre de lancements et l’origine au premier démarrage ; les horaires inchangés conservent leurs calendriers natifs.

Pendant un passage admis, seules les instructions et les notes suivent le contrat d’édition des textes actifs : les modifications sont inscrites dans son historique et enregistrées pour les futurs passages. Les tâches, consignes, profils et identités d’exécution existants conservent leurs valeurs admises. Les champs structurels restent verrouillés jusqu’au règlement du passage, y compris après une pause. Un scénario reste verrouillé dès qu’une tâche a été créée, même terminée ou retirée. Une admission/commande incertaine ou des preuves d’intégrité incomplètes maintiennent l’édition structurelle en lecture seule. Créer et Modifier partagent la validation du calendrier.

La source de branche locale comprend les branches sans worktree et lit uniquement les références locales. Le sélecteur accepte jusqu’à 200 branches locales ; un inventaire plus grand affiche la source comme indisponible. **Démarrer** et **Reprendre** demandent votre accord avec les chemins exacts quand l’activation est disponible. **Lancer maintenant** reste désactivé avec une explication tant que la programmation native est inactive ; activez `experimental.schedules` dans la configuration OpenCode, puis actualisez. Une réponse d’activation perdue conserve la requête d’origine pour actualiser son reçu.

Une confirmation directe de l’activation peut poursuivre l’action que vous venez de demander. Si l’activation est confirmée plus tard par **Actualiser la requête enregistrée**, attendez la vue actualisée, puis choisissez vous-même **Démarrer** ou **Reprendre**. La récupération conserve la requête d’origine et attend votre prochaine action explicite pour démarrer le travail.

Avant le premier Play, vous pouvez retirer tous les critères de lancement pour un lancement unique au démarrage en gardant les conversations suivies dans **Options**. Play lit et fige leur préfixe de messages complets et stables (32 messages par source au plus, dans une enveloppe de lancement de 16 384 caractères). Une source absente, déplacée ou dépassant la capacité bloque le lancement avec une explication. Une reprise conserve le contexte figé et l’identité du lancement d’origine.

Lorsqu’une lecture du reçu confirme une préparation partielle, **Réessayer** apparaît. Ce clic vérifie de nouveau le même reçu et reprend uniquement la modification enregistrée d’origine, en gardant la mission en pause.

Avant le premier lancement d’une nouvelle mission préparée, vous pouvez modifier son titre, ses instructions, ses notes, son playbook, ses agents/modèles/réflexion demandés, le mode des sessions de tâches et sa **Programmation**. Vous pouvez ajouter ou retirer des critères de lancement en conservant la même Mission. Enregistrer la garde en pause et prépare un nouveau coordinateur vide ; la conversation initiale est conservée. Seul Play démarre le travail ou arme une programmation. Après lancement, les instructions et notes suivent les règles d’édition de la mission active. Si l’enregistrement reste incertain, **Actualiser la requête enregistrée** lit son résultat d’origine ; conservez cette requête tant qu’une préparation partielle bloque Play, l’édition des textes et la suppression.

Utilisez **Modifier la mission sélectionnée** sous **Plus d'actions** (⋯) sur une mission ponctuelle ou une programmation native modifiable. Lisez les explications près des champs verrouillés. En cas de conflit de révision, choisissez **Recharger la configuration actuelle**, puis ouvrez **Ancien brouillon pour comparaison** pour examiner le brouillon conservé avant d’enregistrer à nouveau. Les programmations quotidiennes existantes conservent les commandes de leur propre barre d’outils.

Pour une programmation native, **Supprimer la mission sélectionnée…** désactive les futurs passages avant de retirer l’entrée. Conversations et résultats sont conservés ; le nettoyage en attente de réconciliation reste visible dans **Détails techniques**. Conservez une suppression non confirmée et actualisez sa requête d’origine.

1. Pour une mission ponctuelle devenue inutile, choisissez **Supprimer la mission sélectionnée…** et examinez la confirmation.
2. Sélectionnez éventuellement **Supprimer aussi les conversations spécialistes créées pour cette mission** avant de confirmer.
3. Vérifiez dans **Nettoyage des conversations** les nombres supprimés/conservés/en attente. Réessayez seulement le nettoyage restant enregistré si proposé.

Supprimer une mission n’est pas l’arrêter ; utilisez d’abord l’arrêt et inspectez le travail restant. Les coordinateurs et conversations réutilisées sont conservés. Les spécialistes partagés, déplacés, ayant des enfants ou dont la propriété n’est pas vérifiable peuvent aussi être conservés. Un nettoyage partiel n’est ni annulé ni terminé silencieusement en arrière-plan. La carte de la mission peut disparaître alors que la confirmation de la suppression reste en attente, même lorsque le nettoyage des conversations affiche 0 en attente. Continuez à utiliser l’action **Réessayer** d’origine jusqu’à confirmation de la suppression ; elle conserve la même demande de suppression et les mêmes options. Le lecteur d’ensemble conserve les 20 nettoyages terminés les plus récents. Supprimer des missions libère leur stockage dans le projet : les missions supprimées plus anciennes sont effacées automatiquement.

Voir [Autorisations](permissions.md), [Conversations](conversations.md) et [Configuration d’OpenCode](opencode.md) pour le travail natif et les commandes du service.
