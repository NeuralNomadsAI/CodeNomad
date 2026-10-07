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

**Exigence confirmée : le plugin est autonome dans le service OpenCode, avec
l'interface ET le serveur intermédiaire CodeNomad fermés.** Le service OpenCode
reste nécessaire. Maintenir le backend CodeNomad en arrière-plan n'est pas une
solution de remplacement acceptable. Cette clarification du 7 octobre est conservée
dans [`MISSIONS_AUTONOMOUS_PLUGIN_REQUIREMENTS.md`](MISSIONS_AUTONOMOUS_PLUGIN_REQUIREMENTS.md).
**Aucune modification d'OpenCode n'est autorisée** : utiliser les mécanismes natifs
existants et vérifier leur composition, sans imposer une extension upstream.
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
  les politiques d'admission existantes en déplaçant leur exécution et leurs
  protections dans OpenCode : environnement/profil, propriété, stockage,
  restauration froide et programmation. Aucun backend CodeNomad permanent ni
  deuxième moteur de workflow ne doit être requis pour un passage.
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
| Autonomie de l'admission dans OpenCode | migration des politiques actuelles vers le plugin/service natif ; `host-lifetime/` reste un travail conservé distinct, pas la cible d'autonomie |

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
| Programmer | Prochain passage clair ; preuve après fermeture réelle de tous les clients ET du backend CodeNomad, service OpenCode seul |
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
| Autonomie native, backend CodeNomad fermé | Admission/profil/autorité/réveil à porter dans OpenCode ; aucun backend persistant ne remplace ce critère. Fondations host conservées séparément, non activées |
| Admission de création partagée | Commits locaux `860ed92e` ; 30 checks ciblés, typecheck et revue sans régression trouvée. Préparation récurrente réutilisable, mais aucun déclenchement sans autorisation permanente réelle |
| Journaux finis et archivage des passages | Commit local `ce4b58fd` ; 72 checks ciblés, trois défauts corrigés et clôturés indépendamment (7/7 plus probes). Les journaux historiques sont conservés, sans garantie de taille disque bornée |
| Restauration d'une autorisation déjà acceptée | Commit local `f6973b96` ; 43/43 checks aux empreintes inchangées, revue clôturée et zéro acquisition ordinaire. Fondation conservée distincte : ne remplace pas l'autonomie native demandée |
| Autorisation permanente et enfants finis | Commit local `112c0836` ; 17/17 auteur/maître/reviewer, dont 1 025 passages sans accumulation des grants ordinaires. Trois défauts corrigés et clôturés ; proof/observations natives encore à intégrer |
| Approbation finale de récurrence | Commit local `354acfaa` ; 57/57 checks et typecheck, revue indépendante 40/40 et zéro finding. Le callback final reste strict après préparation ; refus sans effet et pending incertain conservé sans replay |
| Admission directement dans OpenCode | Commit local `e63c182c` ; 13/13 auteur/maître/reviewer, deux défauts d'approbation corrigés et clôturés. Fixture réelle 2.0.24 du helper haut niveau : ENV et prompt/synthetic admis sans backend ni modification OpenCode. Writer/gate injectés, Location chargée ; autorité native complète et réveil froid encore à prouver |
| Commit de métadonnées natif | Commit local `6ba741c4` ; transaction réelle OpenCode 2.0.24, rollback après écriture et exclusion par une claim native concurrente. P1 de retrait tardif corrigé et clôturé indépendamment ; ce n'est pas encore un producteur d'autorité permanent |
| Incarnation native gérée exacte | Commit local `65dd66a4` ; identité réelle du service/processus/exécutable/DB, challenge de stockage, 7 rollbacks post-écriture, concurrent standalone même DB refusé. Revue clôturée sans finding ; restart refuse l'enrollment devenu stale, sans réautoriser. Exclusion permanente, checkpoint indépendant et requalification positive restent à terminer |
| Signataire public et checkpoint indépendant | Fixture opt-in `3e205b52`, vrai 2.0.24 : signature vérifiée, tears avant/après commit et restauration complète de DB valide refusée, opération incertaine conservée sans replay. Revue sans finding, 16 empreintes vérifiées. CAS public, fence famille synchrone et provenance native encore à composer ; pas de gate de production |
| Fence famille synchrone | `7e38122d` : observations privées fraîches, marqueur/token exacts et release en attente clôturent le guard final natif. 16/16 author/main, typecheck, vrai commit/rollback 2.0.24, revue ciblée sans finding. CAS public et provenance signataire restent séparés ; aucune activation |
| Activation à froid du plugin | Redémarrage privé réel 2.0.24 : une claim enregistrée recharge le plugin sans demande de Location après boot. L'outil est marqué aborted, pas repris ; deux requêtes modèle. Activation prouvée, programmation/continuité encore non qualifiées |
| Callback natif de veille | Fixtures opt-in `bdd6f874`, probe privé 2.0.24 : hook context attend avant le modèle, vraie claim conservée sur deux reprises, éviction/Park ferme le Scope. 1 admission / 1 outil / 1 requête modèle, sans replay. Revue ciblée clôturée sans finding ; rétention automatique, limite de dix reprises et autorité complète encore à qualifier |
| Bootstrap desktop ordinaire | Commit local `1f0954da` ; transport borné/privé et publication native des cookies sérialisée/vérifiée. 22 Node et 14 Rust passent ; finding macOS IPv4 corrigé et clôturé, revue sans finding restant. Pas de qualification packagée ni d'activation de la fondation host |
| Démarrage froid de la fixture header | Commit local `35af6332` ; cache détenu et préparation Vite existante, 33/33 cas, 7/7 régressions et 3 relances badge, assertions et délai 15 s inchangés. Revue indépendante clôturée ; CI précédente toujours en échec |
| Propagation d'annulation d'autorité | Commit local `7d292121` ; trois catches préservent la raison exacte du demandeur, autres erreurs natives opaques. 10/10 checks combinés et typecheck, revue indépendante 3/3 sans finding ; aucune réservation/Play admis rejoué ou effacé |
| Custody du scan worktree rejeté | Commit local `973d775b` ; stoppe les admissions et attend les lectures déjà admises avant le refus original. 10/10 checks et typecheck, revue sans finding avec deux probes de failure-path ; aucune assertion/délai de production relâché |
| Admission pending chargée seule | `01d63a0b` : 195 → 130 commandes Git, revalidation fraîche pré/post-RPC et drain des lectures refusées. 26/26, typecheck, revue 6/6 sans finding, expiration réelle 30 s sans RPC/publication. Aggregate complet 2 370/0/8, 625 inputs inchangés ; aucune suppression d'assertion ni hausse de délai |

Publication Git rétablie : **`01d63a0b`** et les preuves sont poussés jusqu'à
**`3b40f9b1`**. Les erreurs GitHub Internal Server Error/GraphQL précédentes sont
conservées ; elles avaient laissé le ref à `29084987`. Aucun fichier LFS/verrouillable
concerné et aucun réglage Git persistant changé. La description est revalidée
séparément ; publication ne signifie ni succès de l'aggregate ni autonomie livrée.
| Focus des actions Mission | Commit local `32c308a1` ; 9/9 ciblés et cinq répétitions, revue indépendante 9/9 sans finding. Suite complète **sans capture : 758/0/2**, zéro annulation, 760 cas et 2 162 empreintes inchangées |

### Preuves actuelles et prochaine boucle

- Dernier aggregate serveur Windows après les corrections natives : **2 335 pass,
  16 fail, 3 annulés, 8 skipped**, 2 362 cas sélectionnés, **619 empreintes inchangées**.
  Résultat conservé ; diagnostic parallèle des processus/délais et observations
  d'autorité. Le fichier d'admission Mission repasse **11/11** inchangé en isolation ;
  cette relance ne remplace pas l'aggregate en échec ni ses autres cas à qualifier.
- Comparaison complète à concurrence 2 : **2 351 pass, 3 fail, 0 annulé, 8 skipped**,
  toujours 2 362 cas et **619 empreintes inchangées**. Restent l'annulation masquée,
  le délai d'admission inchangé des 64 dossiers et un `EPERM` de nettoyage de fixture
  Git. Correction minimale d'annulation **`7d292121`**, 10/10 checks et revue clôturée.
  Le diagnostic Git reproduit la libération prématurée d'un scan rejeté alors
  qu'une lecture déjà admise continue ; correction au seam partagé **`973d775b`**,
  pas un retry de suppression. Validation complète série terminée : **2 366 cas /
  2 357 pass / 1 fail / 0 annulé / 8 skipped**, **623 inputs inchangés**. Seul reste
  le cas des 64 dossiers à **31,06 s** pour un délai d'admission toujours **30 s**.
  Une limite série ne suffit donc pas à elle seule ; diagnostic des lectures Git
  pré/post-RPC, sans augmenter le délai, retirer les assertions ou ajouter de cache
  d'autorité/fallback de chargement massif. Ces trois aggregates en échec sont conservés.
- Diagnostic isolé inchangé : **195 commandes Git**, dont 65 comparaisons initiales
  répétées avant le RPC ; **26,742 s** sur ce run, sans effacer l'échec complet.
  Correction ciblée en cours pour classer une fois au dernier passage autoritaire
  pré-RPC, puis revalider après le RPC : **130 commandes mesurées**, cas original
  **12,576 s**, **22/22 checks** et typecheck. La revue répète 5/5 mais confirme un
  P2 latent : refus HTTP avant settlement des lectures déjà admises. Drain ciblé
  corrigé aux deux sites : **26/26 checks**, 4 négatifs reproduisent l'ancien défaut,
  **0 lecture Git en vol** au nettoyage, cas original **10,710 s**. Revue finale
  clôturée **6/6 sans finding**, 9 fixtures nettoyées, expiration réelle 30 s sans
  RPC/publication ; correction **`01d63a0b`**. Nouvel aggregate série complet terminé :
  **2 378 cas / 2 370 pass / 0 fail / 0 annulé / 8 skipped**, **625 inputs inchangés**,
  tous les 623 chemins précédents conservés. Huit nouveaux cas broker et quatre
  famille-sync expliquent l'augmentation, aucun test original retiré. CAS public,
  ownership Job, réveil froid et fixtures natives opt-in restent séparés ; les trois
  aggregates en échec antérieurs sont conservés.
  Délai, limites,
  rejet des clones étrangers et fences conservés.
- Probe natif d'inactivité terminé : **63 minutes** sans polling, prompt ou
  keepalive. Éviction automatique vérifiée à **60 min 59,823 s**, claim libérée,
  **1 admission / 1 outil / 1 modèle**, outil original aborted, aucun replay.
  Le graphe après la demande finale est **nouveau**, pas une survie ininterrompue.
  Raison exacte d'interruption **Unknown**, sans payload historique ; le log prouve
  l'éviction automatique de Location. Nettoyage original encore **non qualifié** :
  ACK de fermeture du fork superviseur absent, supplement **confirmed:false**.
  Les 14/0 checks des nouvelles fixtures ne réécrivent pas ce run. Preuve fraîche
  de cleanup séparée : préflight **4/4**, **0 lancement natif**, encore
  `confirmed:false`. Deux producteurs à compléter — attente sur un vrai handle
  du daemon et annulation post-ACK au superviseur — sans assimiler absence de PID
  à un acquittement ni imposer un second délai de 63 minutes. La limite native de
  dix reprises est **par exécution**, réinitialisée par sa terminaison, pas une
  limite permanente de session. Le handover fini autorisé et son ACK incertain
  restent à qualifier. Après éviction, le callback est fermé mais la claim observée
  reste non nulle ; seul le Park explicite du probe a établi sa libération.
  L'essai court suivant a les ACKs natifs mais pas la fermeture complète du
  superviseur ; il reste **non qualifié**. Revue : **un P2** reproduit, validation
  asynchrone d'ACK encore en vol lors de la déconnexion IPC. Aucune seconde admission
  native pendant la revue. Correctif figé : **13 + 5 checks**, puis revue finale
  **19/19 sans finding**, sans CLI/admission native. Un seul nouvel essai court
  autorisé, qualification en attente de ses ACKs réels. Résidus connus de l'essai
  précédent morts, sans inventer l'ACK historique absent.
- Un propriétaire natif distinct est identifié dans la source exacte : `Job.start`
  adopte le travail dans le Scope du daemon, sans emprunter celui du plugin. Probe
  réel d'éviction/acquisition fraîche/shutdown en préparation. La persistance après
  restart n'est pas fournie par les Jobs génériques ; réveil froid encore séparé,
  sans faux recovery Shell/subagent ni backend CodeNomad de substitution.
- Probe Job encore **incomplet** : invocation expirée sans receipt ni ACK de
  fermeture. Les observations antérieures de Job actif après éviction ne prouvent
  pas son arrêt avec le service. Diagnostic de custody en cours, aucun doublon ou
  probe park-claim lancé ; un Scope frais n'est pas le Scope propriétaire natif.
  Correction du chemin d'erreur/handle : **6 checks**, dont sortie d'un enfant
  réellement possédé ; pas encore de nouvelle qualification du daemon natif ni
  d'ACK historique. Custody physique actuelle réglée séparément : aucun résidu
  correspondant observé, aucun process tué. Le stop Windows stock termine le
  processus sans attendre les finalizers ; une preuve de vie liée au processus
  reste distincte d'une fermeture gracieuse de Scope et des effets incertains.
  Nouveau run stock-stop : **49,8 s**, **2 Jobs / 1 acquisition fraîche / 1 marqueur
  due**, sans prompt/modèle ni Job.cancel, ACKs daemon/sentinel/worker observés.
  Revue accepte cette portée liée au processus, **finalizer null**. Correction de
  custody revue avec 2 checks ajoutée ensuite ; candidat corrigé exécuté en
  **57,8 s**, mêmes comptes/ACKs, sources inchangées, revue indépendante clôturée.
  Fixture opt-in **`1465793f`**, 2 checks répétés par main ; aucune preuve de
  persistance, autorité ou Scope gracieux. Probe claim inactive/reprise froide
  suivant séparé, pas une activation.
- La piste d'un module évalué au boot sans Location n'est pas établie : le receipt
  inspecté était un **claim-timer**, chargé par une acquisition native de Location.
  Découverte des dépendances ≠ exécution. Aucun bootstrap self-HTTP non prouvé ajouté ;
  conservation native d'une claim inactive encore à examiner séparément.
- Source uniquement : une interruption directe du contexte peut conserver la
  claim racine inactive, classée nativement « shutdown » **sans arrêt du daemon**.
  Ce n'est ni un succès ni un reset des dix reprises. Pause/Stop d'un acteur déjà
  inactif, passage fini et reprise froide restent à prouver avant toute activation.
- Nouvel aggregate navigateur ordinaire lancé après la correction header, sans
  capture native externe, sur **2 162 inputs figés**. Commande, assertions et délais
  inchangés ; aucun résultat annoncé avant completion, qualifications natives séparées.
- Run serveur intégral antérieur : **2 279 pass, 0 fail, 8 skipped**, terminé sur
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
  perd ce seul cas externe et gagne la régression de chargement. La revue
  indépendante clôture ces corrections sans finding restant ; elle vérifie aussi
  la conservation de l'erreur initiale et le nettoyage après import retenu.
- Run ordinaire sans capture sur `e56cf0c9` : **757 pass, 1 fail, 2 skipped**, les
  2 162 inputs restent identiques. Le seul échec est la référence Electron prise
  avant l'application de sa géométrie native : renderer 911 px alors que le contenu
  natif est déjà 885 px, reproduit dans deux lancements sur cinq. La fixture attend
  maintenant ces dimensions natives avant sa référence ; **5/5 relances passent**,
  sans retirer de champ du contrôle de reset ni changer produit/menu/deadline.
  La revue indépendante clôture cette correction à zéro finding et reproduit
   **1/1**. Le run complet suivant sur `d2a5fddb` finit à **757/1/2**, avec les
   2 162 empreintes inchangées ; le seul échec est le focus d'un menu Mission.
   Reproduction puis correction `32c308a1` : autofocus d'ouverture réellement
   attendu et focus inline conservé lors d'une vraie permutation. **9/9** et cinq
   répétitions, revue indépendante **9/9 / zéro finding**. Le nouveau run complet
   sans capture après cette correction termine à **758 réussites, 0 échec,
   2 skips, 0 annulation** sur 760 cas ; les **2 162 empreintes sont inchangées**.
   Cette preuve renderer/native-fixture Windows ne qualifie pas l'autonomie du
   plugin et ne remplace pas l'échec hébergé distinct ci-dessous.
- CI **37613611661** sur `d2a5fddb` : **757/1/2**, zéro annulation. Le seul échec
  est `header-windows.test.ts:39`, timeout de chargement de la fixture **avant** les
  assertions de badge, distinct du focus local. Minimum/latest, compatibilité et
  pruning sur trois OS, Tauri Windows/macOS et les étapes serveur passent ; les
  étapes Linux Tauri ultérieures et le build sont sautés après l'échec navigateur.
  Cause reproduite : compilation à froid de la fixture, avant les assertions.
  Préparation native de Vite testée en isolation : trois chargements **2,10–2,18 s**,
  mêmes réglages/assertions/délai **15 s**. Le run local aux inputs gelés est
   terminé ; correction ciblée **`35af6332`**, avec cache détenu et helper existants.
   Sources corrigées figées : **33/33** cas header, **7/7** régressions et **3**
   relances badge, chacune **1/1** ; revue indépendante **7/7** probes, zéro finding.
   Les neuf caches détenus sont absents. Ce succès local ne remplace pas la CI en
   échec ni un nouvel aggregate complet sur ces sources.
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
   ordinaire autorisé pour poursuivre ce qualifier host conservé séparément.
   Il ne remplace pas l'autonomie du plugin avec le backend CodeNomad fermé et
   son test négatif n'est pas une qualification de continuité native.
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
