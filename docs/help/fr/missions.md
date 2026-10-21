# Missions

Les Missions associent un plan de projet durable aux conversations natives OpenCode. Le coordinateur planifie et délègue ; l’arbre des tâches enregistre dépendances et résultats. Un plan enregistré, une entrée admise et une exécution observée sont des faits différents.

## Créer, puis démarrer explicitement {#create}

1. Ouvrez **Missions** dans le panneau droit et choisissez **Créer une mission**.
2. Remplissez **Que doit faire la mission ?** et vérifiez **Titre**, prérempli depuis la première phrase (jusqu’à 60 caractères).
3. Sous **Quand**, sélectionnez **Une fois** ou **Chaque jour à**. Pour un travail quotidien, vérifiez le fuseau affiché ; **Modifier** permet un fuseau IANA.
4. Développez **Options** pour **Scénario**, **Notes**, **Agents et modèles**, **Sessions des tâches**, les consignes enregistrées et les conversations suivies facultatives. Avec **Comparer deux modèles**, les sélecteurs **Modèle A** et **Modèle B** apparaissent dans le formulaire principal.
5. Choisissez **Créer**. Sélectionnez la nouvelle entrée, puis utilisez son action ▶ distincte lorsque vous êtes prêt : **Démarrer la mission** pour un travail ponctuel, ou **Démarrer le programme {id}** pour un programme quotidien.

**Créer ne démarre jamais le travail.** Une mission ponctuelle est préparée ; un programme quotidien est en pause. Ni la création ni l’enregistrement d’une consigne n’arment un minuteur. La création est limitée au projet/à la Location sélectionné et fige les profils demandés ainsi que la politique des sessions de tâches. La validation se trouve près du champ concerné ; un refus indiquant que rien n’a été envoyé laisse le brouillon disponible pour correction. Le coordinateur d’une mission ponctuelle peut aussi préparer pour vous une mission distincte, par exemple une suite : elle apparaît dans la liste comme **Préparée** et, comme toute mission, ne démarre que par son action ▶.

### Scénarios {#playbooks}

| Scénario | Travail prévu |
| --- | --- |
| Mission flexible | Le coordinateur choisit un plan tenant compte des dépendances pour l’objectif. |
| Débogage | Diagnostic, mise en œuvre, revue séparée des normes/spécifications et nouvelle validation ; la résolution poursuit avec l’implémenteur. |
| Exploration | Cartographie les incertitudes et traite des décisions délimitées avec des questions humaines. |
| Livraison de produit | Coordonne les rôles d’analyse produit, d’architecture, de mise en œuvre et de qualité. |
| Comparer deux modèles | Exécute la même tâche avec des consignes identiques sur **Modèle A** et **Modèle B**, puis un **Juge à l’aveugle** note les deux sous des étiquettes neutres et rend un verdict : **Le modèle A l’emporte**, **Le modèle B l’emporte**, **Équivalents** ou **Non concluant**. |

Pour **Comparer deux modèles**, les deux modèles sont obligatoires et doivent différer ; un niveau de **Réflexion** différent ne suffit pas à en faire un autre modèle. Sauf si vous en choisissez un, le juge utilise le modèle du coordinateur ; le formulaire avertit lorsqu’il correspond à A ou B, ce qui peut biaiser la comparaison. La vue d’ensemble affiche le verdict, le nom des deux modèles et les notes par critère.

Le scénario guide la coordination ; il ne contourne pas les autorisations natives et ne garantit pas le succès. Répondez aux questions de décision d’Exploration via le dock d’interruption CodeNomad pour enregistrer une réponse explicite de l’interface, plutôt que de demander à un agent d’imiter une approbation.

## Suivre l’arbre et lire les résultats {#tracking}

1. Sélectionnez le titre de mission. Le chevron de tête maintient sa liste ouverte ; le champ de titre ouvre un sélecteur temporaire.
2. Choisissez **Résumé** (œil) pour la vue centrale, ou sélectionnez un nœud de tâche pour son résultat, sa consigne et ses preuves exacts.
3. Suivez les liens de dépendance et **Rapports** ; utilisez **Ouvrir la conversation** pour le coordinateur si vous avez besoin de sa transcription.
4. Sous **Votre réponse est attendue**, choisissez **Répondre** pour ouvrir la conversation de l’acteur demandeur et le dock d’interruption.

| Indicateur | Ce qu’il établit |
| --- | --- |
| Assignée | Une entrée a été admise ; la consommation par le modèle/le travail/la fin ne sont pas prouvés. |
| En cours | Une activité native a été observée. |
| En attente | Les dépendances déclarées ne sont pas encore satisfaites. |
| Bloquée | Un blocage a été signalé, pas nécessairement une question pour vous. |
| Attend votre réponse | Un Form/une question ou autorisation native ouverte attend une réponse ; elle figure sous **Votre réponse est attendue**. |
| Terminée | Un résultat de tâche a été enregistré ; vérifiez ses preuves et le travail natif restant. |
| Échec / Retirée | La tâche a échoué, ou le coordinateur l’a remplacée ou abandonnée. |

Le graphe inclut les travaux terminés et retirés. Retirer une tâche n’arrête pas en soi sa conversation. Dans une mission ponctuelle, le coordinateur peut arrêter séparément les conversations d’une tâche retirée qu’il a lancée comme sous-agent natif, sans toucher aux autres tâches. **En cours** est l’état du cycle de vie de la mission, pas une preuve que son coordinateur travaille actuellement. Les textes complets se lisent dans le lecteur central, pas dans la liste des tâches ; **Détails techniques** replie les identifiants et les informations d’exécution demandées.

### Points de situation et demandes de mise à jour {#briefings}

Le coordinateur reçoit l’instruction de publier un point sur le projet après son plan initial, après le règlement des tâches, lorsqu’il attend un humain et avant le rapport final. Il s’agit d’une évaluation rédigée, pas d’un compteur d’activité en direct ni d’un signal périodique garanti. Un avis indique si le plan a changé depuis ce point.

Utilisez **Demander un point** sous la barre d’outils pour une nouvelle évaluation du coordinateur, puis lisez **Résumé**. **Point demandé…** signifie que la demande attend, pas qu’elle a reçu une réponse. **Envoi non confirmé** n’autorise pas le renvoi automatique : ouvrez la conversation du coordinateur avant de faire une nouvelle demande séparée. C’est une entrée native ordinaire, pas un bac à sable en lecture seule ; le coordinateur conserve ses autorisations normales.

## Profils, délégation et profondeur {#profiles}

1. Utilisez l’engrenage des Missions ou **Paramètres → Missions** pour modifier **Défauts des nouvelles missions**.
2. Sous **Appliquer à**, choisissez **Toutes les missions** ou un scénario, puis réglez **Sessions des tâches** et, sous **Agents et modèles**, une ligne par rôle (coordinateur, puis les rôles du scénario). Chaque choix est enregistré immédiatement ; il n’y a pas de bouton Enregistrer.
3. Dans la portée d’un scénario, les lignes affichent les valeurs globales marquées **Global**. Modifier un champ personnalise ce rôle à partir de ces valeurs ; son icône de retour réutilise les valeurs globales. **Réinitialiser** (après confirmation) efface seulement les agents et modèles de la portée affichée.
4. À la création, utilisez **Options → Agents et modèles** pour des profils demandés spécifiques ; **Utiliser les réglages enregistrés** rétablit ceux qui sont enregistrés.
5. Pour les limites de récursion native, modifiez **Profondeur d’imbrication des sous-sessions → Profondeur imposée pour le projet**. Appuyer sur Entrée ou quitter le champ enregistre une valeur valide modifiée ; **Hériter** enregistre aussitôt ; Échap abandonne une valeur non enregistrée.

| Réglage | Portée et effet |
| --- | --- |
| Défauts des nouvelles missions | Valeurs par défaut de la configuration pour les **nouvelles** missions seulement ; une exception de scénario remplace la valeur générale. |
| Agent / Modèle / Réflexion | Sélections demandées du coordinateur/des rôles enregistrées à la création ; un acteur occupé ne change pas silencieusement pour un travail ultérieur. Les exécutions quotidiennes réutilisent leurs profils demandés figés. |
| Sous-agents natifs | Les sessions de tâches utilisent les agents natifs subagent/all sous le coordinateur. |
| Sessions indépendantes | Les sessions de tâches déclarées utilisent les agents primary/all et des conversations indépendantes ; cela ne désactive pas les assistants natifs internes. |
| Profondeur d’imbrication des sous-sessions | Configuration de projet pour **toutes** les conversations OpenCode qui s’y trouvent, pas seulement les Missions. Vide hérite. L’enregistrement ne recharge pas OpenCode et ne change pas les conversations actives. |

**Valeur native par défaut** et **Global** diffèrent : le premier demande les valeurs par défaut propres à OpenCode, le second hérite du choix global ; choisir les valeurs natives par défaut dans la portée d’un scénario reste une exception explicite. La disponibilité du catalogue est vérifiée ; un profil demandé ne prouve pas celui qu’utilise actuellement une conversation. Les autorisations natives et la profondeur configurée régissent toujours les appels d’assistants internes dans les deux modes de tâches.

Un choix refusé ou non confirmé n’est jamais renvoyé : les valeurs enregistrées sont réaffichées, et **Recharger** n’apparaît que lorsqu’elles ne peuvent pas être lues. Si un changement de profondeur n’est pas confirmé, votre valeur est conservée ; utilisez **Actualiser la profondeur du projet** avant un autre changement. N’interprétez pas **Profondeur OpenCode effective inconnue** comme zéro ou désactivée.

## Réutiliser une consigne enregistrée {#saved-briefs}

1. À la création, développez **Options → Partir d’une consigne** et sélectionnez la consigne enregistrée.
2. Vérifiez l’objectif, les notes, le scénario, les profils et la délégation copiés avant **Créer**.
3. Utilisez **Enregistrer comme consigne** pour nommer un brouillon réutilisable. Une mission ponctuelle sélectionnée, même terminée, propose aussi **Enregistrer comme consigne**.

Les consignes stockent les instructions et choix demandés, pas les plans de tâches, résultats, conversations, horaires de programme ou autorité d’exécution. En charger une remplit un brouillon de création ordinaire ; cela ne démarre ni ne planifie rien. Retirer une consigne conserve les missions/conversations existantes. **Paramètres → Missions → Consignes enregistrées** gère la bibliothèque ; si celle-ci devient illisible, **Réinitialiser la bibliothèque enregistrée** (après confirmation) retire les consignes enregistrées, pas les exécutions. Les programmes eux-mêmes n’ont pas d’action d’enregistrement comme consigne.

## Heure quotidienne, rattrapage et conversations suivies {#daily-schedules}

Les programmes quotidiens utilisent le fuseau IANA et l’heure civile enregistrés, pas un intervalle écoulé de 24 heures. Les heures sont affichées dans le fuseau du programme, indiqué s’il diffère de celui du lecteur. Chaque exécution reçoit son coordinateur et son plan de mission isolé ; le programme sélectionné affiche l’arbre actuel et l’historique date/résultat. Sélectionnez une ancienne exécution pour la lire au centre. L’historique est limité à 30 résultats.

| Situation | Comportement de planification |
| --- | --- |
| Plusieurs jours d’échéance manqués | Exécute uniquement le dernier jour dû postérieur au marqueur quotidien réglé, pas une file pour chaque jour manqué. |
| Saut à l’heure d’été | Avance à la première minute valide suivante ; un saut en fin de journée franchit la limite du jour. |
| Heure répétée | Utilise la première occurrence ; ne crée pas une seconde exécution quotidienne. |
| Jour civil entièrement sauté | Aucune exécution n’existe pour ce jour. |
| Horloge reculée | Ne rend pas de nouveau dû un jour déjà traité. |
| Exécution existante encore en attente | Ne la fait pas chevaucher une nouvelle exécution quotidienne. |

La date de création limite aussi les jours admissibles ; démarrer un nouveau programme n’autorise pas à traiter des dates antérieures à son existence. **Lancer maintenant** démarre une exécution manuelle séparée si proposé ; cela ne remplace pas l’horaire quotidien et ne contourne pas une exécution en attente. La prochaine heure affichée est une projection, pas une garantie d’exécution à l’heure exacte.

**Conversations suivies (facultatif)** ajoute un contexte borné des conversations choisies. Seule une exécution terminée avance leurs curseurs de messages traités ; une exécution échouée/interrompue ne consomme pas silencieusement ce contexte. Si les instructions et le contexte dépassent la capacité, raccourcissez les instructions ou retirez des conversations suivies au lieu de supposer qu’un historique illimité est lu.

## Durée de vie et redémarrages du service {#lifetime}

| Composant | Ce que signifie sa fermeture |
| --- | --- |
| Onglet de projet CodeNomad | Ferme le projet dans CodeNomad ; les sessions natives continuent dans OpenCode. Rouvrez le projet pour les retrouver. |
| Fenêtre entière, fermeture de l’application ou rechargement du moteur de rendu | Conserve les connexions de projet pour la restauration ; n’arrête pas le travail natif ni le service OpenCode. |
| Backend CodeNomad | N’arrête pas OpenCode. La coordination ponctuelle CodeNomad dépend de sa présence ; ne supposez pas que de nouvelles affectations/commandes ponctuelles restent disponibles lorsqu’il est fermé. |
| Programme quotidien actif | Son horloge et l’exécution des passages fonctionnent dans le plugin/service OpenCode, y compris avec l’interface et le backend CodeNomad fermés. L’hôte d’exécution et le service OpenCode doivent rester actifs. |
| Redémarrage du service OpenCode | Perd les tâches de planification propres au processus. Un programme censé être actif devient **Interrompue** jusqu’à un **Reprendre** explicite ; rouvrir CodeNomad ne le réarme pas. |

Après un redémarrage, inspectez l’exécution en attente et choisissez **Reprendre** lorsque vous êtes prêt. La reprise réconcilie l’exécution existante sans envoyer deux fois l’entrée au coordinateur ; elle ne promet pas de poursuivre un tour natif interrompu. Un tour coupé par un redémarrage peut se régler comme terminé sans rapport, avec **Interrompue par un redémarrage**. N’utilisez pas le redémarrage pour réessayer les effets d’outils.

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

La pause ponctuelle interrompt la famille native de la mission et suspend la coordination ; l’arrêt annule aussi les entrées/livraisons familiales en file et est terminal. Ces opérations sont bornées : **Certains sous-agents sont peut-être encore actifs.** signifie que l’arrêt est incomplet. Inspectez le résultat conservé et utilisez son nouvel essai explicite au lieu de supposer que tous les effets shell/outils ont été annulés. La reprise informe le coordinateur des descendants interrompus ; il doit décider comment poursuivre.

La pause/l’arrêt quotidien annule la planification et demande l’interruption des acteurs racines enregistrés, dont le coordinateur et les spécialistes indépendants, mais **ne prouve pas que ces conversations ou leurs descendants sont arrêtés**. Inspectez les familles natives. L’arrêt est terminal : un programme arrêté ne peut pas démarrer, reprendre ou lancer maintenant. **Vérifier le passage** réconcilie une exécution en attente sans la renvoyer. Les échecs transitoires de vérification planifiée affichent leur dernier échec et sont réessayés automatiquement ; une réponse perdue à une commande utilisateur ne provoque pas son renvoi automatique.

Pour un coordinateur ponctuel inactif sans rapport, l’action principale ▶ peut le vérifier et le récupérer ; les tâches disposent d’une récupération ciblée de rapport manquant si admissible. La récupération vérifie d’abord l’activité native, les descendants et les attentes ; une activité inconnue refuse l’admission. Elle ne rejoue pas les affectations et ne remplace pas le plan. Ouvrez les conversations pour résoudre les questions, autorisations, shells ou travaux en arrière-plan restants.

Si **Créer** n’est pas confirmé, la fenêtre conserve la demande soumise et désactive toute autre création pour ce projet ; la suppression de worktree peut rester bloquée. Actualiser lit seulement l’état. Fermer/rouvrir l’éditeur ne répare pas cela. Avant de recharger la fenêtre, inspectez la liste des missions : recharger efface le verrou local, **sans prouver que la création a échoué**. Ne créez pas aveuglément un doublon après un rechargement ou redémarrage.

## Modifier, supprimer et nettoyer les conversations {#cleanup}

Utilisez **Modifier la mission sélectionnée** sur une mission ponctuelle modifiable ; en cas de conflit, fermez/rouvrez l’éditeur pour charger la révision actuelle plutôt que l’écraser. Les programmes quotidiens ne proposent pas de modification/suppression.

1. Pour une mission ponctuelle devenue inutile, choisissez **Supprimer la mission sélectionnée…** et examinez la confirmation.
2. Sélectionnez éventuellement **Supprimer aussi les conversations spécialistes créées pour cette mission** avant de confirmer.
3. Vérifiez dans **Nettoyage des conversations** les nombres supprimés/conservés/en attente. Réessayez seulement le nettoyage restant enregistré si proposé.

Supprimer une mission n’est pas l’arrêter ; utilisez d’abord l’arrêt et inspectez le travail restant. Les coordinateurs et conversations réutilisées sont conservés. Les spécialistes partagés, déplacés, ayant des enfants ou dont la propriété n’est pas vérifiable peuvent aussi être conservés. Un nettoyage partiel n’est ni annulé ni terminé silencieusement en arrière-plan. L’historique du nettoyage terminé reste disponible dans le lecteur d’ensemble.

Voir [Autorisations](permissions.md), [Conversations](conversations.md) et [Configuration d’OpenCode](opencode.md) pour le travail natif et les commandes du service.
