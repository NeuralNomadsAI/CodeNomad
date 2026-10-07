# Missions : coordination native, suivi utile et missions récurrentes

## Intention produit

Piloter un travail confié à plusieurs agents sans devoir suivre tous leurs outils
ni comprendre l'architecture interne : **ce qui est demandé, où on en est,
ce qui nécessite une réponse, ce qui a été obtenu et ce qui vient ensuite**.

Cette PR réintroduit Missions après l'annulation de #673 par #831. Elle reprend
le produit initial, son évolution vers les sous-agents natifs, le suivi durable,
les contrôles humains et la refonte ergonomique. Elle porte aussi le cahier des
charges des missions permanentes et programmées demandé pendant cette revue.

La description est le contrat de livraison et l'index de revue. Les fonctionnalités
ci-dessous sont suivies jusqu'à leur implémentation et leur vérification ; la table
d'avancement distingue le code poussé, le travail local et le travail à livrer.

## 1. Créer et réutiliser une mission

- Un objectif ou une consigne permanente, un scénario et un coordinateur.
- Trois scénarios : mission personnalisée, **Pocock** pour corriger un bug avec
  diagnostic, implémentation, revues indépendantes et validation fraîche ;
  **Wayfinder** pour explorer, éclaircir les décisions et cartographier le travail.
- Des profils demandés par rôle : agent, modèle et variante de raisonnement.
  Le rôle métier ne devient pas un identifiant d'agent ou de modèle.
- Des briefs réutilisables : charger copie les consignes dans une nouvelle création ;
  supprimer un brief conserve toutes les missions et conversations déjà exécutées.
- Une création préparée, puis **Play** explicite. Les choix sont figés dans
  l'identité de cette création, y compris lorsqu'une réponse réseau est incertaine.

Les préférences globales sont dans une section **Préférences**, initialement
repliée en bas de l'onglet Missions, disponible aussi lorsque la liste est vide
ou qu'une lecture échoue. Elles ne sont plus une rubrique des Settings généraux.
Les brouillons non sauvegardés et leur attente de comparaison sont conservés
pendant la navigation ; une modification extérieure ne les écrase pas.

## 2. Déléguer sans réinventer OpenCode

Le coordinateur déclare le travail, ses dépendances et les résultats attendus.
**OpenCode2 crée et exécute les conversations et sous-agents** ; Missions
n'implémente pas une deuxième boucle d'exécution des agents.

- **Sous-agents natifs par défaut** : la déclaration retourne un contrat/brief
  canonique pour l'appel natif. Le parent reçoit les résultats natifs ; le
  coordinateur enregistre le résultat métier d'une tâche déclarée.
- Le travail indépendant prêt peut se dérouler en parallèle. Chaque enfant peut
  décomposer son travail lorsque les permissions et la profondeur natives le
  permettent. Aucun nombre de niveaux n'est un objectif imposé.
- Les tâches déclarées et les helpers internes sont distincts : chaque descendant
  n'a pas à recopier son résultat dans un deuxième rapport Missions.
- Une **session indépendante** est une option explicite, notamment pour un autre
  emplacement, une conversation existante ou un cycle de vie distinct.
- Le choix **Sessions des tâches : sous-agents / sessions indépendantes** est une
  politique des nouvelles missions. Choisir les sessions indépendantes ne bloque
  pas les helpers natifs internes de ces agents et ne modifie aucune mission existante.
- Les profils de tâches respectent ce choix : `subagent/all` pour le natif,
  `primary/all` pour les sessions indépendantes ; coordinateur `primary/all`.
- La **profondeur native OpenCode** est un réglage séparé, au niveau de la Location,
  avec chemin du fichier, valeur effective et override local. Elle affecte aussi
  les autres conversations à cet emplacement. Sauvegarde explicite, comparaison
  du fichier original, héritage possible, sans reload/restart automatique.

Les tâches gardent leur génération et les conversations leur identité exacte.
Une dépendance métier n'est pas un lien de parenté natif. Une réutilisation
explicite du contexte ne fabrique pas une dépendance. Un acteur occupé n'est pas
reconfiguré pour accepter un nouveau travail ; un refus natif de profondeur ou
de permission n'est pas contourné par la création automatique d'une session maître.

## 3. Comprendre et piloter le travail

### Hiérarchie de lecture

1. **Demandes réellement à traiter** : Forms et permissions natives, avec leur
   provenance et accès à la demande exacte dans le dock existant.
2. **Bilan du coordinateur** : synthèse datée de l'état, des acquis, obstacles et
   prochaines étapes. Le bouton demande un bilan sans devoir écrire un prompt.
3. **Travail actuel** : tâches compactes et graphe de dépendances, avec accès direct
   au résultat de chaque tâche.
4. **Détails techniques** repliés : rapports enregistrés, conversations observées
   et modifications du plan. Les résultats précédents restent consultables.
5. **Préférences** et reçus de nettoyage : accessibles sans concurrencer le suivi.

Le panneau sert à lire l'essentiel et naviguer. Les textes complets, preuves,
artefacts et briefs sont dans le **lecteur central au-dessus du transcript**.
L'œil reste visible, s'allume pour sa cible exacte et ferme cette même cible au
second clic. Fermer le lecteur éteint les indicateurs correspondants.

### Sens de chaque surface

- **Travail** : le plan déclaré, dans un ordre stable, y compris les tâches
  terminées/retirées utiles à la compréhension des dépendances.
- **Rapports** : une seule histoire des résultats, avec les anciens essais et
  rapports tardifs ; pas une deuxième liste du travail restant.
- **Conversations** : l'ascendance réellement observée, coordinateur, acteurs et
  descendants. Une branche inconnue reste inconnue. Navigation par identité exacte.
- **Modifications du plan** : raison et changements concrets, avec anciennes et
  nouvelles valeurs dans le lecteur ; pas un mur de metadata dans le panneau.
- **Nettoyage** : reçus de suppression ou raisons de conservation, pas des archives
  restaurables. Les opérations incomplètes priment sur les traces terminées.

Le bilan indique sa date et sa fraîcheur. Un nouveau résultat ou une modification
du plan peut rendre ce bilan ancien sans effacer son contenu ni inventer une
nouvelle synthèse. Un obstacle rapporté ne devient pas automatiquement une demande
de décision humaine. « Mission ouverte », « agent actif », « input admis » et
« objectif atteint » ont chacun leur sens.

### Actions humaines

- **Play / Pause / Stop** dans une seule bande de contrôle.
- Donner une direction et poser une question au coordinateur sont des actions
  distinctes, avec leurs propres brouillons ; elles ne changent pas silencieusement
  le plan ni la conversation sélectionnée.
- Reprise ciblée du coordinateur ou d'un rapport manquant depuis les lignes
  existantes, sans rejouer l'affectation initiale.
- Suppression de la carte indépendante de la suppression facultative des sessions
  gérées. Le coordinateur, les conversations réutilisées/partagées/déplacées et les
  racines avec descendants sont conservés.

## 4. Missions permanentes et programmation

**Exigence demandée : les passages doivent fonctionner avec CodeNomad fermé.**
Une mission laissée active dans le panneau ne satisfait pas cette exigence.

### Parcours minimal

- Choisir **Ponctuelle** ou **Récurrente** lors de la création.
- Pour la récurrence : consigne permanente, heure quotidienne et fuseau horaire ;
  pas d'éditeur cron ni de workflow visuel.
- Voir **prochain passage**, **dernier bilan** et les demandes en attente.
- **Lancer maintenant**, suspendre et reprendre la programmation sans effacer
  les résultats. Arrêter définitivement demeure une action distincte.
- Chaque passage a un début, un état et un résultat ; il peut se terminer sans
  clôturer la mission permanente. Aucun agent n'attend en boucle jusqu'à demain.

### Cas d'usage de référence

Chaque jour, relever les PR CodeNomad nouvelles ou mises à jour, reviewer les
versions encore non traitées, puis consulter les nouvelles réponses dans les
conversations explicitement suivies depuis le dernier passage. Produire un bilan
**traité / à décider / rien de nouveau**, avec des liens vers les sources.

Le suivi utilise les identités de PR, leurs commits et les réponses/messages,
pas seulement « depuis hier ». L'analyse, la publication d'une review, la
modification du code et la fusion sont des autorisations distinctes ; programmer
une revue ne vaut pas consentement à fusionner.

### Contrat d'exécution à vérifier

- Réutiliser le service **OpenCode2 déjà permanent** et le plugin Missions.
  Fermer la fenêtre n'est ni Pause, ni Stop, ni arrêt du daemon.
- Porter le déclenchement et son état durable hors de la vue UI. Réutiliser
  l'admission autorisée existante lorsqu'un environnement frais ou un contrôle
  de propriété est nécessaire, pas un deuxième moteur de workflow.
- Un seul passage par mission à la fois ; identités stables avant tout effet.
- Une publication incertaine est conservée pour réconciliation, jamais republiée
  aveuglément. Une réponse en attente ne crée pas une nouvelle exécution concurrente.
- Après veille/indisponibilité, un rattrapage borné plutôt qu'une avalanche de
  passages manqués. Tester changements d'heure, fuseaux et redémarrage du service.
- À la réouverture, retrouver la même mission, ses passages et bilans, sans
  resoumettre une consigne ni réinitialiser le suivi.
- Ordinateur éteint : pas d'exécution locale ; le rattrapage s'applique au retour
  du service. Un hôte distant reste une possibilité de déploiement distincte.

Le maintien d'un travail natif déjà admis après fermeture est implémenté. Le
déclenchement d'un **nouveau passage programmé** après fermeture et redémarrage
doit encore être livré et prouvé ; ce sont deux tests différents.

## 5. Architecture et points d'entrée

| Responsabilité | Modules principaux |
| --- | --- |
| Sessions, sous-agents, inbox, permissions et exécution | OpenCode V2, contrats natifs effectivement consommés |
| Carte métier, génération des tâches, résultats et historique | `packages/server/src/missions/{control,model,journal,task-declaration}.ts` |
| Contexte du coordinateur et playbooks | `missions/{recipes,contracts,playbook-profiles}.ts` |
| Outils et RPC natifs | `opencode/missions-plugin.ts`, `missions/rpc.ts` |
| Disponibilité/retention du plugin | `opencode/missions/{desktop-plugin,lifetime}.ts`, `desktop-plugin-presence.ts` |
| Admission propriétaire, environnement et contrôles humains | routes Missions et `mission-input`, `workspaces/session-environment.ts`, `settings/admission-environment.ts` |
| Résultats, notifications et reprise ciblée | `missions/{notification-outbox,native-report-provenance,native-recovery-observation}.ts` |
| Lecture et ergonomie | `MissionControl`, composants `mission-*`, `stores/mission-view-state.ts` |
| Préférences / profils / briefs réutilisables | `mission-preferences`, `mission-defaults`, `mission-model-library`, comparaison conditionnelle des préférences |
| Profondeur locale | `opencode/subagent-depth-settings.ts`, route dédiée, `mission-subagent-depth.tsx` |
| Continuité de l'admission hors fenêtre | fondations `host-lifetime/`, `missions/durable-host/`, `native-host-lifetime/` ; composition à qualifier |

Le journal natif append-only est la vérité métier reconstruite ; les événements
signalent une invalidation, puis l'UI relit un snapshot autoritaire. L'activité
native est observée séparément. Les lectures d'affichage sont cache-first et
limitées à la demande visible ; les mutations revalident leurs autorités.

Les admissions sont liées au projet, à la Location exacte, au profil et à la
connexion, avec fences de suppression/déplacement et environnement complet frais.
Les secrets restent hors de l'UI et des prompts. Une réponse perdue n'autorise ni
un nouvel acteur, ni un autre transport, ni une répétition automatique de mutation.

Le stockage est neuf : `codenomad-missions/v2` et
`codenomad-missions/authority-v2`, version wire/schema 1. Les anciens espaces ne
sont ni lus, migrés ni supprimés. Les contrats natifs sont vérifiés par capacité ;
les versions utilisées pour compiler ne sont pas une allowlist du daemon installé.

## 6. Cahier des charges UX et acceptation

| Parcours | Résultat attendu et vérification |
| --- | --- |
| Créer | Voir les choix effectifs sans ouvrir un catalogue ; conservation exacte après réponse incertaine |
| Suivre | Comprendre les acquis, obstacles et prochaines étapes sans ouvrir les détails techniques |
| Répondre | Ouvrir la bonne demande native sans perdre le brouillon ni répondre à une autre conversation |
| Lire | Texte complet par pages bornées, copie de l'original, cible/focus conservés pendant les refreshs |
| Naviguer | Aucun résultat tardif ne remplace une nouvelle sélection, un lecteur ou une autre conversation |
| Configurer | Préférences dans Missions, séparation global/nouvelle mission et local/OpenCode, CAS et brouillons conservés |
| Programmer | Prochain passage clair ; preuve de déclenchement après fermeture réelle de tous les clients |
| Reprendre | Même identité après reconnexion/redémarrage ; ni doublon de coordinateur ni replay incertain |
| Échouer | Erreur actionnable et état conservé ; inconnu ne devient pas terminé |
| Touch/étroit/RTL | Actions accessibles, lecteur central utilisable, contrôles compacts, focus et clavier corrects |

Réutiliser les composants existants, les tokens et le chrome carré ; tous les
libellés sont localisés dans les dix langues. Pas de nouvelles cartes décoratives,
de texte permanent redondant, de page d'administration ou de fermeture ajoutée
dans une ligne dédiée. Les longs contenus restent dans le lecteur, pas le panneau.

## 7. Avancement et revue — 2026-10-07

La PR reste ouverte ; la fusion est suspendue à la demande de l'utilisateur.

| Lot | État constaté |
| --- | --- |
| Réintroduction, natif, contrôles, bilan et suivi | Publié ; corrections jusqu'au head `32ee0fc5`, revue des seams d'intégration clôturée sans finding restant dans son périmètre |
| Capacité, conflits de création et deadline Stop native | `530dc8af` / `bd2a8cee` poussés ; corrections et preuves conservées |
| Préférences dans Missions, politique des tâches, profondeur locale et corrections UX | Publié dans `972910fe` ; revue indépendante corrigée et clôturée dans ce périmètre, typechecks vérifiés |
| Missions permanentes, programmation et suivi des passages | Noyau durable publié, non activé (`1a17bbcc`), 22 tests et revue indépendante sans finding restant ; raccordement natif, archivage, réveil froid et UX à terminer |
| Admission durable hors fenêtre et parité packagée | Fondations présentes ; travail d'intégration/qualification à terminer, sans contournement des protections natives |

### Preuves actuelles et prochaine boucle

- Nouveau run serveur intégral : **2 279 pass, 0 fail, 8 skipped**, terminé sur
  les inputs d'exécution inchangés. L'ancienne preuve **2 247/0/8** reste datée ;
  ce succès ne qualifie ni les fixtures natives opt-in ni le host packagé.
- Suite navigateur complète exploratoire : **711 pass, 39 fail, 2 skipped**.
  Ce résultat reste enregistré, il n'est pas remplacé par la somme de reruns.
- Nouveau run navigateur intégral : **758 pass, 0 fail, 2 skipped**, 760 cas
  sélectionnés sans exclusion. Le replay utilise un capture natif historique avec
  digest explicite, uniquement pour qualifier le renderer actuel ; pas le host
  persistant ou une admission native récurrente.
- CI complète `37599765514` sur `32ee0fc5` : **755 pass, 3 fail, 2 skipped**
  au navigateur ; serveur, runtime minimum/latest, compatibilité/pruning sur les
  trois OS et Tauri Windows/macOS passent. Deux assertions françaises précèdent
  l'import du dictionnaire ; le troisième cas exige une capture privée absente.
  Les reçus locaux verts ne remplacent pas ce résultat hébergé.
- Corrections ciblées : géométrie mesurée après traduction effective, avec un
  import français volontairement retenu (**11 contrôles passent**). Le replay
  privé est désormais une qualification explicitement invoquée ; aucune assertion
  retirée, aucun skip ajouté. Sans capture : échec obligatoire. Avec la capture
  auditée : **1/1**, digest inchangé, zéro requête externe. L'aggregate ordinaire
  perd ce seul cas externe et gagne la régression de chargement ; nouveau run
  ordinaire sans capture lancé avec 2 162 inputs fingerprintés, nouvelle CI à
  obtenir après publication. Ces exécutions n'ont pas encore de résultat final.
- Livraison UX sur sources plus récentes : **240 tests Missions navigateur** et
  **32 tests unitaires/parité** passent selon le rapport de livraison ; les revues
   ciblées sont clôturées, les aggregates ci-dessus gardent leur périmètre exact.
- Typechecks serveur/UI relancés après séparation du contrat HTTP de profondeur :
  passent. Tests natifs isolés de profondeur JSONC, création/autorité HTTP-RPC
  (16 gates OpenCode 2.0.24) et environnement minimum 2.0.7 ont leurs reçus propres.
- Boucle de revue UX : trois défauts reproduits puis corrigés ; zéro finding
  actionnable restant dans ce périmètre, cinq régressions et probes indépendantes.
  Nouveau parcours natif 2.0.24 : parallélisme, récursion réelle, lecture des retours
  puis résultats métier passent, sans liaison enfant fabriquée.
- Rerun natif intégral 2.0.24 sur le head publié : **16 gates passent**, zéro
  échec (catalogue, politique native/indépendante, ENV frais, outbox/recovery sans
  replay, Play/Pause/Stop, nettoyage opt-in et conservation des transcriptions).
  Ce test garde son périmètre natif ; il ne qualifie pas le réveil froid récurrent.
- Revue indépendante des seams d'intégration : **230 contrôles passent**, zéro
  finding actionnable. Politique figée/autorité, profondeur/CAS, ressources,
  isolation des outcomes et copie complète enfant sont tracés, sans approbation
  globale du produit ni activation de la récurrence.
- Le noyau de récurrence (`recurrence-{contract,clock,store,runner}`) n'est pas
  activé : 22 tests passent, dont modèles sans variante, DST en fin de journée et
  retrait/réajout d'un suivi sans perdre son curseur. La revue indépendante ferme
  les trois défauts initiaux ; stockage borné testé à 194 067 / 262 144 octets.
- Qualification Windows indépendante : build release et vrai loader natif passent,
  puis `native-parent-job-forbids-breakaway` bloque la première naissance hors Job
  depuis le harness. Ce refus reste intact, sans fallback. Il faut un parent Windows
  ordinaire autorisé pour poursuivre les preuves de backend, service et fermeture
  desktop ; ce test négatif n'est pas une qualification de continuité.
- CI de l'ancien head `cfea513b` reste en échec ; elle n'est pas effacée par les reruns.
  Les corrections de fixtures/packaging et le vrai loader compilé sont publiés.
  Les 14 tests Tauri cross-host actuels passent, y compris les deux échecs hébergés ;
  des diagnostics de timings sont ajoutés uniquement aux tests, sans élargir les
  délais ou affaiblir la propriété. La nouvelle CI sur `3250150b` passe les trois
  plateformes de compatibilité, minimum/latest, pruning et Tauri macOS, mais
  échoue sur deux fixtures : le scanner i18n référence l'ancien composant Settings
  supprimé ; le loader reçoit un chemin temporaire court `RUNNER~1`, refusé par
  son contrôle canonique. Les deux échecs sont reproduits localement ; un vrai
  addon charge via le chemin canonique sur Node 24.20.0 sans affaiblir le loader.
  Les corrections sont publiées dans `32ee0fc5` : six contrôles i18n/parité et le
  vrai loader avec TEMP court sur Node 24.20.0 passent, loader produit inchangé.
  Ces deux étapes corrigées passent dans la CI complète citée plus haut.
- Les manifestes des suites locales montrent uniquement ces deux
  modifications de fixtures hors de leur sélection ; les sources d'exécution
  restent inchangées pour les deux suites terminées. Les corrections de tests
  ultérieures nécessitent une nouvelle preuve navigateur ; il ne s'agit pas d'un
  gel de l'ensemble du dépôt.
- Reproduire/corriger les échecs actuels, reviewer les seams d'intégration, répéter
  jusqu'à zéro finding actionnable, puis source figée et validation combinée
  navigateur/natif/packaging. Les scénarios sont vérifiés dans des fixtures privées,
  sans mutation des missions live, de la configuration utilisateur ou du daemon partagé.

## 8. Documentation et histoire utile

- [Contrat fonctionnel et modules](MISSIONS.md).
- [Comparaison native-first et décision d'architecture](MISSIONS_NATIVE_INTERFACE_COMPARISON.md).
- [Essais empiriques, fermeture/réouverture et admission offline](MISSIONS_EMPIRICAL_WORK_MAP.md).
- [Contrat de continuité et d'autorisation](MISSIONS_CONTINUITY_CONTRACT.md).
- [Acceptation native assemblée](MISSIONS_NATIVE_PRODUCT_ACCEPTANCE.md) et
  [journal des validations/corrections](MISSIONS_REFACTOR_VALIDATION.md).
- [Refonte UI et intégration upstream](MISSIONS_UI_REFRESH_20261004.md).
- PR historique [#673](https://github.com/NeuralNomadsAI/CodeNomad/pull/673),
  revert [#831](https://github.com/NeuralNomadsAI/CodeNomad/pull/831).

L'histoire fournit les choix et leurs preuves, pas une spécification immuable.
Par rapport à #673, les acteurs ne sont plus exclusivement des roots, les outils
incluent révision et briefing, la distribution utilise le bundle provisionné,
et les préférences/lecteurs remplacent les anciennes surfaces. Les résultats
historiques restent datés ; ils ne certifient pas le code actuel.
