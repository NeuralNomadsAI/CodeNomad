# Missions

Une Mission rassemble un objectif, une conversation de coordination, des tâches et leurs résultats. Ouvrez **Missions** dans le panneau droit.

## Créer une Mission {#create}

Choisissez **Créer une mission**. Le formulaire remplace l’arbre jusqu’à la création ou l’annulation. Ses groupes suivent l’ordre ci-dessous.

### Configuration {#saved-briefs}

**Configuration** charge éventuellement un objectif, des notes, un scénario et des choix d’agents, de modèles et de sessions enregistrés. Son nom fournit le titre modifiable. Vérifiez les champs remplis avant de créer.

**Enregistrer la configuration**, en bas à côté d’Annuler et Créer, nomme et conserve une configuration réutilisable. Cette action ne crée ni ne démarre de Mission. Programmation et **Démarrer automatiquement** se règlent séparément. L’engrenage des Missions ouvre les Préférences et la bibliothèque ; supprimer une configuration conserve les missions et conversations existantes.

### Objectif, Titre et Notes {#mission-instructions}

- **Objectif** : le résultat souhaité et comment le vérifier.
- **Titre** : le nom dans l’arbre. Pour une Mission vierge, il suit la première phrase de l’objectif, dans la limite de 60 caractères ; vous pouvez le modifier.
- **Notes** : du contexte, des contraintes ou des consignes complémentaires pour les agents, facultatifs. Mettez-y ce qui est utile au travail, plutôt que des réglages d’interface.

### Options et scénario {#playbooks}

**Scénario** choisit la méthode de travail du coordinateur : Mission flexible, Débogage, Exploration, Livraison produit ou Comparer deux modèles. [Scénarios](playbooks.md) décrit leurs rôles et étapes.

Le scénario guide les agents dans leurs permissions natives. Un commit, push, une pull request ou une modification du suivi de tickets demande une instruction explicite pour cette action dans l’objectif ou les Notes.

### Délégation et profondeur {#profiles}

**Sessions des tâches** choisit des **Sous-agents natifs** sous le coordinateur, ou des **Sessions indépendantes**. Les deux restent soumis aux permissions et limites d’imbrication d’OpenCode.

**Profondeur des sous-agents** est un réglage de projet pour toutes ses conversations OpenCode. Choisissez **Hériter** ou une profondeur de 1 à 10 ; ce choix est enregistré immédiatement. Le **ⓘ** indique la profondeur effective observée, les permissions d’imbrication et les fichiers de configuration. Un enregistrement échoué ou non confirmé conserve son avertissement et propose une actualisation explicite.

Enregistrer une profondeur de projet autorise aussi les sous-agents à déléguer dans cette limite, en primant sur les restrictions de General d’autres fichiers lorsque le réglage est compatible. Une règle de projet incompatible conserve son avertissement. **Hériter** retire la règle ajoutée. Enregistrer ne recharge pas OpenCode et ne modifie pas les conversations en cours.

### Agents et modèles {#agents-models}

Dépliez **Agents et modèles** pour modifier une ligne Agent / Modèle / Réflexion par rôle. Le résumé conserve les choix demandés lorsque le groupe est replié. La création part des défauts des Préférences ; les modifications ici concernent cette Mission.

L’engrenage des Missions ouvre les défauts pour **Toutes les missions** ou pour un scénario. Les Préférences enregistrent chaque modification immédiatement. Les listes de modèles suivent la visibilité et les favoris du sélecteur de conversation ; un modèle enregistré hors de la liste reste sélectionné.

**Comparer deux modèles** exige des modèles différents pour A et B ; changer seulement Réflexion ne suffit pas. Le juge aveugle utilise le modèle du coordinateur sauf choix différent. Employer A ou B comme juge peut biaiser la comparaison.

Une programmation gérée par calendrier nécessite un agent et un modèle explicites pour le coordinateur et chaque rôle du scénario.

### Démarrer automatiquement {#automatic-start}

**Démarrer automatiquement** se trouve hors de Programmation et reste décoché par défaut. Laissez-le décoché pour créer une Mission en pause, puis utilisez ▶ **Démarrer** dans l’en-tête. Cochez-le pour demander le démarrage après confirmation de la création, avec les contrôles habituels et l’éventuel consentement aux réglages natifs.

Si l’accusé de création est perdu, lire le reçu laisse le démarrage manuel. Une création non confirmée garde sa requête d’origine ; vérifiez la liste et la conversation avant de créer à nouveau.

## Programmation {#daily-schedules}

### Critères {#native-scheduling}

Le premier critère est **Une fois, maintenant**. **Ajouter un critère** en ajoute un autre ; choisissez son type, retirez-le avec × ou réordonnez les cartes par leur poignée. Alt+Haut/Bas déplace la poignée ayant le focus.

Les horaires proposent Une fois, maintenant, Toutes les N heures, Tous les jours, Jours de semaine choisis, Jour de chaque mois et Avancé (cron). Ils suivent le fuseau enregistré. **Fuseau enregistré (IANA)** apparaît lorsqu’il diffère de celui du système. Les mois sans le jour choisi sont ignorés.

**Une fois, maintenant** prend son instant au démarrage, pas à l’ouverture du formulaire. Il offre une seule occasion, qu’une condition peut consommer sans lancement. Choisissez une récurrence pour des occasions ultérieures. La programmation fonctionne tant que son service OpenCode et son hôte d’exécution sont disponibles.

### Événements et combinaisons {#scheduling-conditions}

Un événement peut suivre la réussite d’un autre programme, une Mission ponctuelle terminée, des commits sur une branche locale, de nouveaux messages ou des changements de fichiers explicites. Choisissez une source du projet. **Conversations suivies (facultatif)** ajoute du contexte séparément du déclencheur.

- **ou** combine des horaires voisins, ou des événements voisins.
- **si** : les événements après des horaires sont leurs conditions. À chaque horaire, l’un d’eux doit avoir changé depuis le dernier passage réussi.
- **sinon** : les horaires après des événements sont un repli. Ils lancent seulement si les critères au-dessus n’ont lancé aucun passage depuis leur créneau précédent, ou leur activation. Les événements placés après ce repli le conditionnent.

Les événements en tête peuvent lancer un passage à chaque nouvelle occurrence ; ils sont vérifiés toutes les 15 minutes. Le premier démarrage fixe la référence des sources. Un passage réussi la fait avancer ; un échec la conserve. Une source absente ou illisible bloque avec une explication. Les passages ne se chevauchent pas.

### Compteurs et historique {#scheduling-limits}

Sélectionnez un programme pour lire son état, le prochain réveil ou contrôle, les nombres de passages lancés et réussis et les **Exécutions passées**. L’historique conserve 30 résultats ; les compteurs cumulés restent. **Lancer maintenant** compte comme passage lancé une fois admis.

Une politique enregistrée que l’éditeur ne sait pas représenter reste sous **Politique de lancement enregistrée** jusqu’à son remplacement explicite. Vérifiez les éventuelles limites de fin ou de nombre de passages avant de modifier.

### Programmations quotidiennes existantes {#existing-daily-schedules}

Les entrées quotidiennes existantes conservent leurs contrôles et leur fuseau. Après un redémarrage du service, elles indiquent **Interrompue** et demandent **Reprendre**. Elles rattrapent le dernier jour admissible plutôt que chaque jour manqué. L’entrée sélectionnée donne accès aux résultats conservés.

## Suivre l’arbre et lire les résultats {#tracking}

Le chevron déplie ou replie les tâches. Cliquer une ligne sélectionne la Mission ou la tâche ; les actions de cette sélection restent dans l’en-tête. Une Mission sans tâche n’a pas de chevron. **Filtrer les missions** filtre le répertoire chargé.

L’œil active **Résumé** dans le lecteur central et suit la sélection tant qu’il est enfoncé. **Ouvrir la conversation** mène au coordinateur ou à la tâche sélectionnée. **Plus d’actions** (⋯) contient les commandes applicables de point d’avancement, interruption, enregistrement de configuration et modification.

Les missions et tâches suivantes se chargent à l’approche de la fin. Les pages de tâches restent en cache indépendamment des lignes affichées. Un échec de lecture conserve l’affichage et propose **Réessayer**. Le chargement utilise l’indicateur d’actualisation de l’en-tête. Lire ou réessayer une lecture ne démarre aucun travail.

### Couleurs et états {#status-colours}

Le drapeau indique l’état de la Mission ; son chevron porte l’attention de ses tâches. Une entrée récurrente utilise une icône de répétition.

| Couleur | Sens |
| --- | --- |
| Rouge | Une question ou permission attend votre réponse. Sélectionnez la Mission ou la tâche concernée pour ouvrir le panneau d’interruption. |
| Jaune pulsant | Une activité native a été observée. |
| Orange | En pause ou interrompue, avec une action pour continuer. |
| Vert | Une Mission ou tâche terminée n’a pas encore été vue dans cette fenêtre. Sélectionnez-la, cliquez ou balayez les icônes vertes des tâches, ou choisissez **Marquer comme lu** dans le menu du chevron. |
| Bleu | Mission préparée ou tâche qui n’a pas commencé. |

Le texte d’état distingue Affectée, Active, En attente, Bloquée, Terminée, Échouée et Retirée. Un blocage signalé n’est pas nécessairement une question pour vous. Un résultat enregistré ne prouve pas que chaque opération native est arrêtée. Retirer une tâche conserve son historique.

### Questions et décisions {#questions}

Le coordinateur a pour consigne de résoudre ce qu’il peut et de vous demander seulement les décisions restantes, accords ou identifiants. Répondez dans le panneau d’interruption. Exploration distingue **Décision du coordinateur** et **Votre réponse** ; avec les Sessions indépendantes, les décisions sont consignées dans Notes. [Scénarios](playbooks.md) détaille ces méthodes.

### Points d’avancement {#briefings}

Le coordinateur a pour consigne de publier des points aux étapes importantes. C’est son évaluation, pas un compteur d’activité en direct. **Demander un point**, sous Plus d’actions, en demande un autre ; lisez-le via Résumé. Si l’envoi n’est pas confirmé, vérifiez la conversation avant une nouvelle demande séparée.

## Contexte et résultats {#context-flow}

Le plan durable conserve objectif, Notes, consignes des tâches, dépendances, résultats et changements de plan. Le coordinateur reçoit l’objectif, les Notes et les instructions du scénario. Une tâche native reçoit l’affectation de son parent ; une tâche indépendante reçoit aussi ses affectations ouvertes. Les assistants reçoivent ce que leur parent leur transmet. Le juge aveugle reçoit les éléments anonymisés de comparaison plutôt que l’objectif et les Notes.

Une nouvelle Mission ou un passage programmé possède son propre plan. Placez les résultats antérieurs utiles dans Objectif ou Notes, ou demandez au coordinateur de les retrouver. OpenCode peut compacter le contexte présenté au modèle tout en conservant l’historique enregistré.

### Rechercher les conversations antérieures {#context-search}

Lorsque CodeNomad fonctionne, les agents peuvent rechercher les conversations enregistrées du projet. Demandez-le explicitement lorsque les conclusions antérieures comptent ; une autre Mission n’hérite pas automatiquement de toute une conversation.

## Fermeture et redémarrages {#lifetime}

Fermer un projet ou CodeNomad n’arrête pas le travail natif OpenCode. Les programmes natifs activés peuvent fonctionner avec CodeNomad fermé tant que le service et l’hôte d’exécution sont disponibles. Un programme natif sain reprend son calendrier après redémarrage du service ; pauses, arrêts et résultats incertains conservent leurs blocages. Les entrées quotidiennes existantes demandent Reprendre après redémarrage.

Certaines actions de coordination et de récupération nécessitent le serveur CodeNomad. Si Missions est indisponible, suivez l’erreur de connexion ou de plugin du panneau sans supposer que le travail enregistré a disparu.

## Pause, arrêt et actions non confirmées {#controls-recovery}

La **Pause** ponctuelle laisse les étapes en cours finir sans en démarrer de nouvelles. **Interrompre maintenant** demande une interruption immédiate. **Arrêter** est définitif et demande confirmation. La pause d’un programme natif ferme les lancements futurs et demande l’interruption du passage en cours. Des effets d’outils peuvent continuer après interruption ; vérifiez les résultats partiels.

Conservez la requête d’origine d’une action non confirmée. Utilisez **Vérifier l’état**, **Actualiser la requête enregistrée** ou le réessai proposé ; ne créez pas de remplacement pour contourner l’incertitude. Actualisation passive et reconnexion ne la renvoient pas. Après confirmation, les nouvelles actions peuvent attendre l’arrivée d’un affichage à jour.

Une Mission ponctuelle interrompue ou échouée peut proposer **Reprendre la mission interrompue**. Les tâches admissibles proposent la récupération d’un rapport manquant. Ces actions vérifient l’activité native et les demandes en attente avant d’autoriser du travail.

## Modifier, supprimer et nettoyer les conversations {#cleanup}

Le nettoyage des conversations de tâches est une option des Missions ponctuelles. Supprimer un programme natif conserve ses conversations.

**Modifier la mission sélectionnée**, sous Plus d’actions, ouvre le formulaire commun. Avant le premier lancement, les champs de préparation se modifient lorsqu’ils sont déverrouillés. Après lancement, instructions et Notes restent modifiables là où c’est permis ; les champs verrouillés indiquent leur restriction. En cas de conflit, rechargez la configuration actuelle et consultez **Ancien brouillon pour comparaison**.

Arrêtez le travail avant de le supprimer. **Supprimer la mission sélectionnée…** retire immédiatement une Mission ponctuelle ; une suppression échouée ou non confirmée garde son **Réessayer** d’origine. Supprimer un programme ferme d’abord ses futurs lancements.

Pour retirer aussi les conversations de tâches admissibles, activez **Supprimer une mission supprime aussi les conversations de ses tâches** dans les Préférences Missions. Coordinateurs, conversations réutilisées ou partagées et celles dont la propriété ne peut pas être établie sont conservés. **Nettoyage des conversations** indique le travail restant et les réessais explicites. Supprimer une configuration enregistrée ne supprime pas de Mission.
