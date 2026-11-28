# Missions

Une Mission rassemble un objectif, une conversation de coordination, des tâches et leurs résultats. Ouvrez **Missions** dans le panneau droit.

Si Missions est indisponible, **Paramètres OpenCode** ouvre la récupération du service pour un plugin absent ou en échec. **Diagnostic serveur** ouvre le rapport de diagnostic dans Paramètres → Info lorsque le pont local Missions du serveur est indisponible.

## Afficher ou masquer Missions {#activation}

Dans **Personnaliser le panneau droit**, cochez **Missions** pour afficher l’onglet, ou décochez et confirmez pour le masquer. Ce geste écrit aussi `codenomad.missions` ou `-codenomad.missions` dans la configuration globale du serveur OpenCode connecté. Une règle du projet peut primer. Désactiver ne supprime ni ne met rien en pause, mais des exécutions planifiées peuvent être manquées. Si l’écriture échoue, l’onglet conserve la visibilité choisie. **Réinitialiser** n’agit que sur la disposition. **Statut → Plugins** omet l’avertissement pour cette règle globale exacte ; les autres désactivations proposent **Réactiver**.

## Créer une Mission {#create}

Les connexions distantes utilisent le même formulaire et les mêmes commandes. Préférez HTTPS pour protéger les échanges réseau.

Choisissez **Créer une mission**. Le formulaire remplace l’arbre jusqu’à la création ou l’annulation. Une création confirmée sélectionne la Mission ; une création refusée laisse le formulaire modifiable.

Demandez à un agent dans toute conversation du projet, y compris un sous-agent ou un passage programmé, de préparer une Mission séparée, ponctuelle ou programmée. Sa conversation reste inchangée ; une nouvelle coordination est créée par défaut. Gardez le backend CodeNomad propriétaire disponible. Demander explicitement **Démarrer automatiquement** autorise le premier démarrage de cette nouvelle Mission ; la récupération lit le résultat d’origine. Les agents peuvent aussi lister, inspecter, démarrer, mettre en pause, arrêter, reprendre, **Lancer maintenant**, vérifier, modifier et supprimer toute programmation du projet, y compris celles créées dans l’éditeur. Les mêmes contrôles de révision et d’admission s’appliquent ; une désactivation explicite de la programmation est préservée. Une action non confirmée conserve sa demande d’origine pour consulter son état en lecture seule.

### Configuration {#saved-briefs}

Les agents peuvent consulter toutes les Missions du projet, y compris les vôtres, depuis toute conversation possédée. Les vues en lecture seule couvrent tâches, résultats, nettoyage, passages programmés et choix des sources ; consulter ne lance ni ne relance le travail.

Les agents peuvent aussi diagnostiquer la programmation, préparer ses réglages en préservant un OFF explicite et reprendre une modification partielle confirmée avec sa demande d’origine.

**Configuration** charge éventuellement un objectif, des notes, un scénario et des choix d’agents, de modèles et de sessions enregistrés. Son nom fournit le titre modifiable. Vérifiez les champs remplis avant de créer.

Les agents peuvent lire, enregistrer, remplacer ou renommer, supprimer et réparer les configurations, y compris enregistrer les instructions d’une Mission existante. Ils peuvent aussi modifier les profils et sessions par défaut, globalement ou par scénario, rétablir l’héritage, réinitialiser les préférences invalides et modifier la préférence de suppression des conversations de tâches. La bibliothèque et ces préférences s’appliquent à tous les projets du profil CodeNomad. La profondeur des sous-agents du projet accepte 1 à 10 ou **Hériter**, avec réparation d’un bloc de configuration vide. Chaque modification vérifie la valeur lue et préserve les changements humains intervenus depuis.

**Enregistrer la configuration**, en bas à côté d’Annuler et Créer, nomme et conserve une configuration réutilisable. Cette action ne crée ni ne démarre de Mission. Programmation et **Démarrer automatiquement** se règlent séparément. L’engrenage des Missions ouvre les Préférences et la bibliothèque ; supprimer une configuration conserve les missions et conversations existantes.

Pour remplacer une configuration enregistrée, utilisez son nom et choisissez **Remplacer**. Si plusieurs portent ce nom, chargez d’abord celle à remplacer. Un nouveau nom crée une copie tant que la bibliothèque dispose de place.

### Objectif, Titre et Notes {#mission-instructions}

Pour les Missions ponctuelles, les agents peuvent démarrer, reprendre, mettre en pause douce, interrompre immédiatement, arrêter, modifier, supprimer, reprendre la coordination après échec, demander un rapport manquant ou un point. Cela inclut vos Missions, avec les mêmes contrôles d’admission et de révision que le panneau. La suppression suit votre préférence de suppression des sessions gérées, sauf choix explicite. Un contrôle ou nettoyage non confirmé conserve son identité ; les agents lisent son état enregistré avant de poursuivre explicitement une action partielle confirmée.

- **Objectif** : le résultat souhaité et comment le vérifier.
- **Titre** : le nom dans l’arbre. Pour une Mission vierge, il suit la première phrase de l’objectif, dans la limite de 60 caractères ; vous pouvez le modifier.
- **Notes** : du contexte, des contraintes ou des consignes complémentaires pour les agents, facultatifs. Mettez-y ce qui est utile au travail, plutôt que des réglages d’interface.

### Options et scénario {#playbooks}

**Scénario** choisit la méthode de travail du coordinateur : Mission flexible, Débogage, Exploration, Livraison produit ou Comparer deux modèles. [Scénarios](playbooks.md) décrit leurs rôles et étapes.

Le scénario guide les agents dans leurs permissions natives. Un commit, push, une pull request ou une modification du suivi de tickets demande une instruction explicite pour cette action dans l’objectif ou les Notes.

### Délégation et profondeur {#profiles}

**Sessions des tâches** choisit des **Sous-agents natifs** sous le coordinateur, ou des **Sessions indépendantes**. Les deux restent soumis aux permissions et limites d’imbrication d’OpenCode.

**Profondeur des sous-agents** est un réglage de projet pour toutes ses conversations OpenCode. Choisissez **Hériter** ou une profondeur de 1 à 10 ; ce choix est enregistré immédiatement. Le **ⓘ** indique la profondeur effective observée, les permissions d’imbrication et les fichiers de configuration.

Les informations de profondeur des sous-agents indiquent leur source effective sous **Fichier de configuration OpenCode :**.

Enregistrer une profondeur de projet autorise aussi les sous-agents à déléguer dans cette limite, en primant sur les restrictions de General d’autres fichiers lorsque le réglage est compatible. **Hériter** retire la règle ajoutée. Enregistrer ne recharge pas OpenCode et ne modifie pas les conversations en cours.

### Agents et modèles {#agents-models}

Dépliez **Agents et modèles** pour modifier une ligne Agent / Modèle / Réflexion par rôle. Le résumé conserve les choix demandés lorsque le groupe est replié. La création part des défauts des Préférences ; les modifications ici concernent cette Mission.

L’engrenage des Missions ouvre les défauts pour **Toutes les missions** ou pour un scénario. Les Préférences enregistrent chaque modification immédiatement. Les listes de modèles suivent la visibilité et les favoris du sélecteur de conversation ; un modèle enregistré hors de la liste reste sélectionné.

**Comparer deux modèles** exige des modèles différents pour A et B ; changer seulement Réflexion ne suffit pas. Le juge aveugle utilise le modèle du coordinateur sauf choix différent. Employer A ou B comme juge peut biaiser la comparaison.

Une programmation gérée par calendrier nécessite un agent et un modèle explicites pour le coordinateur et chaque rôle du scénario.

### Démarrer automatiquement {#automatic-start}

**Démarrer automatiquement** se trouve hors de Programmation et reste décoché par défaut. Laissez-le décoché pour créer une Mission en pause, puis utilisez ▶ **Démarrer** dans l’en-tête. Cochez-le pour demander le démarrage après confirmation de la création, avec les contrôles habituels et la préparation automatique de la programmation.

### Maintenir le coordinateur actif avec /goal {#coordinator-goal}

**Maintenir le coordinateur actif avec /goal** est disponible pour les Missions ponctuelles et décoché par défaut. Une fois coché, le démarrage active `/goal` dans OpenCode sur le coordinateur, la mise en pause et la reprise de la Mission suspendent et reprennent cet objectif, et la fin ou l’arrêt l’efface. Si OpenCode redémarre pendant l’exécution, Missions reprend automatiquement l’objectif mis en pause par le redémarrage (y compris quand CodeNomad est fermé si les automatisations OpenCode sont actives), tout en conservant intactes les pauses manuelles, de blocage ou de limite de tours. L’état en direct et les contrôles s’affichent dans la vue d’ensemble de la Mission.

## Programmation {#daily-schedules}

Une Mission avec un horaire répété ou un événement reste une seule ligne de la liste : chaque lancement remplace le précédent dans la même conversation de coordination, et attend tant que le précédent est encore actif. Son détail affiche **Lancer quand**, **État voulu**, le prochain réveil ou la prochaine vérification, **Passages lancés** et **Exécutions passées** (les 20 derniers lancements). Si **Démarrer automatiquement** est décoché, elle est créée en pause. **Modifier la mission sélectionnée** rouvre le formulaire de création, et le prochain lancement utilise ce que vous enregistrez. **Supprimer la mission sélectionnée…** retire d’abord sa programmation. ⏸ de la barre d’outils la met en pause tout entière, lancement en cours et programmation, et ▶ fait repartir les deux. ■ arrête le lancement en cours ; quand plus rien ne tourne, il arrête définitivement la programmation et laisse la Mission dans la liste.

### Critères {#native-scheduling}

Le bouton **i** ouvre [l’aide de programmation](missions.md#native-scheduling).

Le premier critère est **Une fois, maintenant**. **Ajouter un critère** en ajoute un autre ; choisissez son type, retirez-le avec × ou réordonnez les cartes par leur poignée. Alt+Haut/Bas déplace la poignée ayant le focus.

Les horaires proposent Une fois, maintenant, Toutes les N heures, Tous les jours, Jours de semaine choisis, Jour de chaque mois et Avancé (cron). Ils suivent le fuseau enregistré. **Fuseau enregistré (IANA)** apparaît lorsqu’il diffère de celui du système. Les mois sans le jour choisi sont ignorés.

**Une fois, maintenant** prend son instant au démarrage, pas à l’ouverture du formulaire. Il offre une seule occasion, qu’une condition peut consommer sans lancement. Choisissez une récurrence pour des occasions ultérieures. La programmation fonctionne tant que son service OpenCode et son hôte d’exécution sont disponibles.

Le démarrage ou la reprise prépare automatiquement la programmation dans la configuration OpenCode du projet. Un OFF explicite est conservé : **Ouvrir les réglages de programmation**, lorsque proposé, ouvre le fichier responsable ; le **i** révèle sa provenance ou les détails d’environnement.

### Événements et combinaisons {#scheduling-conditions}

Choisissez **Activité du dépôt → Événement**, puis les filtres éventuels dans la même carte. Les commits Git partagent ce menu avec les événements du dépôt GitHub, GitLab ou Gitea détecté automatiquement, comme dans Contribute (`upstream`, puis `origin`). Les trois proposent les nouvelles PR/MR, les PR/MR fusionnées et les nouvelles issues, avec un **Auteur (facultatif)**, y compris `dependabot[bot]`. Choisir un événement fixe son dépôt ; les critères enregistrés conservent leur cible.

Les contrôles de forge utilisent `gh`, `glab` ou `tea` sur l’hôte OpenCode, même avec CodeNomad fermé ; les dépôts publics peuvent être lus anonymement. Une forge auto-hébergée exige une CLI connectée à cet hôte. **github.com** propose aussi les notifications du compte et les alertes Dependabot via `gh` connecté, avec accès aux [notifications](https://docs.github.com/en/rest/activity/notifications) ou aux [alertes en lecture](https://docs.github.com/en/rest/dependabot/alerts). Les notifications conservent leur état de lecture ; les alertes incluent celles corrigées ou ignorées. Les notifications enregistrées avec un **Dépôt GitHub** vide couvrent le compte. Le premier démarrage fixe la référence.

Un événement peut suivre la réussite d’un autre programme, une Mission ponctuelle terminée, des commits sur une branche locale, de nouveaux messages ou des changements de fichiers explicites. Choisissez la source dans ce critère. La recherche ignore les majuscules et minuscules, y compris pour les lettres accentuées. Pendant une recherche, utilisez **Charger d’autres sources** dans le sélecteur pour poursuivre, même si la page contient déjà des résultats. La conversation choisie pour les nouveaux messages fournit aussi du contexte au passage. Changer le type de critère efface sa source. La modification conserve le contexte de conversation déjà enregistré.

- **ou** combine des horaires voisins, ou des événements voisins.
- **si** : les événements après des horaires sont leurs conditions. À chaque horaire, l’un d’eux doit avoir changé depuis le dernier passage réussi.
- **sinon** : les horaires après des événements sont un repli. Ils lancent seulement si les critères au-dessus n’ont lancé aucun passage depuis leur créneau précédent, ou leur activation. Les événements placés après ce repli le conditionnent.

Les événements en tête peuvent lancer un passage à chaque nouvelle occurrence ; ils sont vérifiés toutes les 15 minutes. Le premier démarrage fixe la référence des sources. Un passage réussi la fait avancer ; un échec la conserve. Les passages ne se chevauchent pas.

### Compteurs et historique {#scheduling-limits}

**Session du coordinateur** utilise par défaut une **Nouvelle session** à chaque passage. Avec un horaire ou événement, **Session existante** permet de choisir une conversation racine du projet et de la même Location d’exécution. Chaque passage y continue avec l’agent et le modèle configurés, en conservant le transcript, le titre et les permissions. Les contrôles de la mission affectent aussi les travaux qui s’y trouvent. Chaque passage garde son résultat et son journal dans les **Exécutions passées** . À chaque lancement, la conversation passe sur l’agent, le modèle et la réflexion du coordinateur.

Vous pouvez demander à un agent de préparer la programmation dans sa conversation racine actuelle. Les passages attendent que la conversation soit au repos.

Sélectionnez un programme pour lire son état, le prochain réveil ou contrôle, les nombres de passages lancés et réussis et les **Exécutions passées**. L’historique conserve 30 résultats ; les compteurs cumulés restent. **Lancer maintenant** compte comme passage lancé une fois admis.

Une politique enregistrée que l’éditeur ne sait pas représenter reste sous **Politique de lancement enregistrée** jusqu’à son remplacement explicite. Vérifiez les éventuelles limites de fin ou de nombre de passages avant de modifier.

Dans **Conversations suivies**, utilisez **Ajouter une conversation** puis choisissez une conversation, y compris pour une Mission immédiate. Avant Play, changez une sélection ou utilisez son bouton × pour la retirer.

Choisissez **Nouveaux commits sur une branche locale** pour suivre une référence Git locale, ou **Nouveaux commits sur une branche distante** et saisissez le nom de la branche (par exemple `dev`). La vérification interroge directement le dépôt distant détecté, sans `git fetch` local. Plusieurs commits entre deux vérifications déclenchent un seul passage.

## Suivre l’arbre et lire les résultats {#tracking}

Le chevron déplie ou replie les tâches. Cliquer une ligne sélectionne la Mission ou la tâche ; les actions de cette sélection restent dans l’en-tête. Une Mission sans tâche n’a pas de chevron. **Filtrer les missions** filtre le répertoire chargé. Missions ponctuelles et récurrentes partagent une seule liste, activité la plus récente en premier ; une exécution planifiée en cours passe en tête.

L’œil active **Résumé** dans le lecteur central et suit la sélection tant qu’il est enfoncé. **Ouvrir la conversation** mène au coordinateur ou à la tâche sélectionnée. **Plus d’actions** (⋯) contient les commandes applicables de point d’avancement, interruption, enregistrement de configuration et modification.

La sélection, les sections développées et le lecteur appartiennent à chaque onglet de projet et sont restaurés avec lui. Des onglets ouverts sur le même projet peuvent lire des rapports différents ou garder un rapport dans l’un et la conversation, un fichier ou un aperçu web dans l’autre. Ouvrir ou fermer un lecteur change uniquement cet onglet ; le travail des Missions et les confirmations de lecture des résultats terminés restent partagés dans la fenêtre.

Les missions et tâches suivantes se chargent à l’approche de la fin. Si le chargement des tâches échoue, utilisez **Réessayer** pour continuer.

### Couleurs et états {#status-colours}

Le drapeau indique l’état de la Mission ; son chevron porte l’attention de ses tâches. Une entrée récurrente utilise une icône de répétition.

| Couleur et forme | Sens |
| --- | --- |
| Rouge | Une question ou permission attend votre réponse. Sélectionnez la Mission ou la tâche concernée pour ouvrir le panneau d’interruption. |
| Jaune | Une activité native a été observée. |
| Symbole pause orange | En pause : rien ne continue ni ne se lance tant que vous ne reprenez pas. |
| Triangle d’avertissement orange | Interrompue, avec une action pour continuer. |
| Vert | Une Mission, tâche ou exécution programmée réussie attend votre consultation dans cette fenêtre. |
| Sablier d’accent | **En attente programmée** : le prochain réveil est confirmé. L’accent suit votre palette. |
| Icône d’accent seule | Mission préparée ou tâche qui n’a pas commencé. |
| Neutre | Fin consultée, programmation arrêtée ou **État non confirmé** ; lisez le texte d’état. |

Sélectionnez une Mission ou tâche verte, cliquez ou balayez les icônes vertes des tâches, ou choisissez **Marquer comme lu** dans le menu du chevron. Pour **Passage réussi à consulter**, sélectionnez explicitement la ligne récurrente dans la fenêtre active ou utilisez **Marquer comme lu**. L’icône revient à l’attente si la programmation reste active, sinon au neutre. Les nouveaux résultats reçus sur une ligne déjà sélectionnée restent à consulter.

Retirer une tâche conserve son historique.

### Questions et décisions {#questions}

Le coordinateur a pour consigne de résoudre ce qu’il peut et de vous demander seulement les décisions restantes, accords ou identifiants. Répondez dans le panneau d’interruption. Exploration distingue **Décision du coordinateur** et **Votre réponse** ; avec les Sessions indépendantes, les décisions sont consignées dans Notes. [Scénarios](playbooks.md) détaille ces méthodes.

### Points d’avancement {#briefings}

Le coordinateur a pour consigne de publier des points aux étapes importantes. C’est son évaluation, pas un compteur d’activité en direct. **Demander un point**, sous Plus d’actions, en demande un autre ; lisez-le via Résumé.

## Contexte et résultats {#context-flow}

Une nouvelle Mission ou un passage programmé possède son propre plan. Placez les résultats antérieurs utiles dans Objectif ou Notes, ou demandez au coordinateur de les retrouver.

### Rechercher les conversations antérieures {#context-search}

Lorsque CodeNomad fonctionne, les agents peuvent rechercher les conversations enregistrées du projet. Demandez-le explicitement lorsque les conclusions antérieures comptent ; une autre Mission n’hérite pas automatiquement de toute une conversation.

## Fermeture et redémarrages {#lifetime}

Fermer un projet ou CodeNomad n’arrête pas le travail natif OpenCode. Les programmes natifs activés peuvent fonctionner avec CodeNomad fermé tant que le service et l’hôte d’exécution sont disponibles. Un programme natif sain reprend son calendrier après redémarrage du service ; pauses, arrêts et résultats incertains conservent leurs blocages.

Certaines actions de coordination et de récupération nécessitent le serveur CodeNomad.

Une Mission ponctuelle en cours continue d’attribuer ses tâches et de transmettre leurs rapports même si aucune fenêtre CodeNomad n’a le projet ouvert. Les variables d’environnement et les réglages de permissions modifiés dans CodeNomad s’appliquent de nouveau à ces conversations dès que le projet est ouvert.

## Pause, arrêt et actions non confirmées {#controls-recovery}

La **Pause** ponctuelle laisse les étapes en cours finir sans en démarrer de nouvelles. **Interrompre maintenant** demande une interruption immédiate. **Arrêter** est définitif et demande confirmation. La pause d’un programme natif ferme les lancements futurs et demande l’interruption du passage en cours. Des effets d’outils peuvent continuer après interruption ; vérifiez les résultats partiels.

Conservez la requête d’origine d’une action non confirmée : tant que la vue d’un programme natif ou l’éditeur est ouvert, CodeNomad la relit automatiquement jusqu’à ce qu’elle soit tranchée et ne relance de lui-même qu’une préparation partielle exactement enregistrée. Utilisez **Vérifier l’état** pour les commandes de Mission ponctuelle, et **Actualiser la carte de mission** pour une création ponctuelle ordinaire lorsqu’ils sont proposés ; ne créez pas de remplacement pour contourner l’incertitude. Un programme natif propose **Vérifier l’état** dans son menu **Plus d'actions**.

Une Mission ponctuelle interrompue ou échouée peut proposer **Reprendre la mission interrompue**. Les tâches admissibles proposent la récupération d’un rapport manquant.

## Modifier, supprimer et nettoyer les conversations {#cleanup}

Le nettoyage des conversations de tâches est une option des Missions ponctuelles. Supprimer un programme natif conserve ses conversations.

**Modifier la mission sélectionnée**, sous Plus d’actions, ouvre le formulaire commun. Avant le premier lancement, les champs de préparation se modifient lorsqu’ils sont déverrouillés. Après lancement, instructions et Notes restent modifiables là où c’est permis ; les champs verrouillés indiquent leur restriction.

Arrêtez le travail avant de le supprimer. **Supprimer la mission sélectionnée…** retire immédiatement une Mission ponctuelle . Supprimer un programme ferme d’abord ses futurs lancements.

Pour retirer aussi les conversations de tâches admissibles, activez **Supprimer une mission supprime aussi les conversations de ses tâches** dans les Préférences Missions. Coordinateurs, conversations réutilisées ou partagées et celles dont la propriété ne peut pas être établie sont conservés. **Nettoyage des conversations** indique le travail restant et les réessais explicites. Supprimer une configuration enregistrée ne supprime pas de Mission.
