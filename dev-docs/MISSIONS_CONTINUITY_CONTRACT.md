> Superseded for recurring missions by [MISSIONS_RECURRING_SIMPLE.md](MISSIONS_RECURRING_SIMPLE.md) (2026-10-08). Historical content is retained; unrelated one-time receipts remain in scope.

# Missions : contrat de continuité et d'autorisation

> PR scope (2026-10-09): host-lifetime, `packages/native-host-lifetime`, the durable host/plugin and their fixtures were moved out of this tree to the local branch `experiment/host-lifetime-foundation-20261009`; spikes and experiments are preserved on `preserve/missions-full-20261009`. References below are historical.

Étude initiale : 2026-10-01. État réconcilié : 2026-10-08. Contrat cible,
**partiellement implémenté, non qualifié pour activation desktop**. L'état des
preuves et des gates est consigné dans `MISSIONS_REFACTOR_VALIDATION.md`.
La réintroduction est ouverte dans [PR #866](https://github.com/NeuralNomadsAI/CodeNomad/pull/866),
après #673 et son revert #831. Sa description fait foi pour la cible produit ;
les lots publiés/locaux/à livrer sont suivis dans `MISSIONS_REFACTOR_VALIDATION.md`. Aucun arrêt du
daemon partagé ni intervention sur les missions live n'est nécessaire à ces tests.

### Cible imposée — clarification du 7 octobre 2026

Le plugin Missions doit être **entièrement autonome dans le service OpenCode**,
avec l'interface **et le serveur intermédiaire CodeNomad fermés**. Un backend
CodeNomad persistant ne satisfait pas cette cible. Voir la demande transmise et
conservée dans `MISSIONS_AUTONOMOUS_PLUGIN_REQUIREMENTS.md`.

L'admission, les autorisations, l'environnement/profil, le stockage et la
programmation doivent s'exécuter côté OpenCode. Les politiques
de sécurité restent obligatoires ; une API manquante est un contrat à implémenter
et qualifier, pas une raison de substituer un backend permanent. Les travaux host
déjà réalisés sont conservés et non activés, avec leurs preuves propres ; leurs
gates ne sont plus les critères d'acceptation de l'autonomie du plugin. Cette cible
prime sur les propositions de backend persistant historiques ci-dessous.
L'utilisateur interdit également de modifier OpenCode. L'intégration doit exploiter
les mécanismes existants du service/plugin et les qualifier ; l'absence d'un domaine
SDK nommé « persistentSchedule » n'est pas une preuve de nécessité d'extension.

### Portée précisée — 8 octobre 2026

Tant que le service OpenCode tourne, il possède les échéances et les passages
finis même si CodeNomad et son backend sont fermés. Le sommeil de la machine
peut entraîner un rattrapage borné dans ce même processus. **Le redémarrage du
service peut perdre le Job de calendrier en RAM** pendant que CodeNomad est fermé.
Rouvrir CodeNomad affiche le calendrier interrompu et attend **Reprendre** avant
de réarmer la Mission encore autorisée, sans rejeu d'effet incertain.
L'auto-réveil pendant que CodeNomad reste fermé après redémarrage n'est plus un
gate de livraison ; les preuves historiques correspondantes restent datées.

### État actuel : fenêtre, plugin et prochain passage

- `retainMissionWork` garde une registration déjà chargée lorsque du travail actif,
  des notifications/contrôles non réglés ou une lecture incertaine subsistent.
  `followPresence` ne crée pas une registration froide sans présence backend.
  Les outils d'un travail retenu ne disparaissent donc pas simplement après 15 s.
- Fermer le dernier desktop appelle encore l'arrêt du backend sur les chemins
  Electron/Tauri actuels. Le daemon OpenCode, lui, demeure externe et n'est pas
  arrêté. Cette distinction n'est pas une admission autonome pour demain.
- Le superviseur Windows indépendant, le service starter et le backend complet
  existent dans `native-host-lifetime/` et `host-lifetime/`. Leur absence ne doit
  pas être invoquée pour créer un deuxième service. Les ressources packagées
  gardent `persistentLaunch: disabled` jusqu'à la qualification de leur composition.
- L'admission lit maintenant le profil frais via `settings/admission-environment.ts`
  et prépare l'environnement complet via `workspaces/session-environment.ts`.
  Une lecture UI des settings en cache n'est pas ce chemin d'admission.
- L'adaptateur local `e63c182c` qualifie aussi cette admission haut niveau dans le
  vrai graphe natif OpenCode 2.0.24, sans backend CodeNomad ni changement upstream.
  L'autorité de writer y reste injectée. `6ba741c4` qualifie séparément le commit de
  métadonnées via la transaction native, pas encore l'autorité permanente complète.
- Une claim native enregistrée recharge réellement le plugin après redémarrage,
  sans demande de Location après boot. L'outil interrompu est marqué aborted et
  une nouvelle continuation modèle démarre ; ce n'est pas une reprise d'outil ni
  un ordonnanceur qualifié. Les reçus et leurs limites sont dans le journal de
  validation, sans transformer les observations de deux secondes en preuve globale.
- La programmation demandée est une autorisation humaine permanente de **passages
  finis**, non un timer choisissant les tâches des agents. Les dépendances,
  sous-agents, inbox et exécutions restent natifs. Un seul passage, un rattrapage
  borné, déduplication durable et non-replay des effets incertains sont requis.
- Qualification restante : clients et backend CodeNomad fermés avec OpenCode
  toujours en marche, environnement modifié avant échéance, passage unique,
  Pause/Stop et conservation des inputs inconnus. La seule rétention d'un plugin
  chargé ne prouve pas ces scénarios.

Les tableaux détaillés ci-dessous conservent leurs preuves historiques datées ;
les constats corrigés ici priment sur leurs anciennes descriptions du code.

### Simplifications autorisées

- Aucune compatibilité avec les anciennes Missions : journal neuf sous
  `codenomad-missions/v2` et autorité sous `codenomad-missions/authority-v2`.
  Les anciens octets restent intacts et sont ignorés ; aucun import, fallback,
  migration ou écran d'adoption des anciennes cartes. La version wire reste 1.
- Les nouvelles Missions conservent l'autorisation signée et Play explicite.
  L'isolation des clés ne qualifie pas à elle seule l'exclusivité des writers
  natifs, la propriété des sessions ou les familles physiques partagées.
- UI minimale : conserver le panneau et les actions existants, placer la reprise
  ciblée sur le coordinateur sélectionné et le travail sans rapport ; aucun
  nouvel écran de gestion de l'autorité ou de migration.
- Étude historique Windows, non gate de l'autonomie native : la topologie envisagée était superviseur S
  propriétaire du Job de runtime, manager Node M affecté avant reprise et
  backend B héritant du Job au spawn Node normal. Cela conserve le vrai IPC Node
  sans adoption privée de canal. S reste hors du Job de runtime ; le service
  starter officiel reste lui aussi à l'extérieur. La preuve combinée est passée,
  mais lancement indépendant, transport produit et parité packagée restent des
  gates distinctes. Voir `MISSIONS_NATIVE_NODE_IPC.md` pour les compromis.

## Proposition historique de backend — remplacée par la cible native

L'étude initiale proposait un backend d'autorisation indépendant des fenêtres,
parce que les interfaces plugin installées n'exposaient pas tous les contrats
d'environnement/inbox du client HTTP. L'utilisateur a explicitement rejeté cette
substitution : ces responsabilités doivent être déplacées dans OpenCode.

Les modules `host-lifetime/` et `missions/durable-host/` restent des fondations
conservées, non une solution livrée à cette demande. Le transfert doit réutiliser
les politiques d'admission et leurs contrôles d'identité/autorisation, sans moteur
de workflow, seconde inbox ou fallback au seul environnement du daemon. Une
autorisation persistée ne dispense pas de l'environnement complet ni des fences.

**Critère d'acceptation :** fermer les clients et le backend CodeNomad ; le service
OpenCode seul retrouve les racines autorisées et admet exactement un passage,
avec son profil, ses permissions et ses identités durables **tant qu'il tourne**.
Après un redémarrage du service, rouvrir CodeNomad affiche le calendrier interrompu ;
seul un Reprendre explicite le réarme, sans rejouer un effet incertain. Les preuves de lancement
indépendant d'un backend ne démontrent pas ce parcours.

## 1. Preuves et limites du contrat natif

Niveaux : **C** = code/déclaration installée ; **D** = documentation publiée ;
**H** = hypothèse/proposition à qualifier dans un runtime privé.

| Capacité | Preuve | Conséquence |
| --- | --- | --- |
| Plugin setup/cleanup, tools, hook context, RPC | C : `node_modules/@opencode/plugin/dist/promise/{plugin,session,rpc}.d.ts` | Disponible tant que la location/plugin reste chargée, pas une garantie de chargement permanent |
| Storage JSON get/set/remove/scan | C : `.../storage.d.ts:3-8` ; D : guide plugins | Durable ; pas de transaction, CAS ou verrou interprocessus déclaré |
| Session create/get/prompt/synthetic/interrupt | C : `.../session.d.ts:143-145` | Transport natif possible, mais sans politique de profil CodeNomad |
| Environment, inbox list/cancel, active, session remove/list | C : `node_modules/@opencode/client/dist/promise/client.d.ts:31-90` ; absents du Pick plugin `session.d.ts:143` | Utiliser l'adapter HTTP autorisé ; ne pas inventer `ctx.session.environment/inbox` |
| Filesystem / lecture des settings CodeNomad | C : aucun domaine filesystem/config dans `plugin.d.ts:25-53` | Aucun accès typé permettant de reproduire la politique execution-host |
| Events subscribe | C : `.../event.d.ts` ; D : guide RPC, abonnements live-only | Invalidation puis read autoritaire ; pas de journal durable d'événements publics |
| Identité du caller RPC | C : `.../rpc.d.ts:5-8`, seulement signal/error | Un input `profileID`, `sessionID` ou `approved:true` n'authentifie pas un utilisateur |
| Outils capturés par un tour | D : guide plugins, snapshot exécutable stable | `assertActive()` refuse une registration disposée ; retention de travail protège une registration existante, pas un chargement froid |
| Enfants natifs | D : guide tools, outil `subagent`, foreground/background | Pas de parentID dans session.create public ; pas d'enfant créé par simple renommage d'un root |

Le guide publié présente notamment `session.remove` dans le contexte plugin,
mais la déclaration installée ne l'expose pas. L'adapter Promise installé
(`.../adapter.js`, construction de `context2.session`) matérialise un ensemble
fini de méthodes, pas le client HTTP complet. La documentation n'est donc pas une
preuve de présence dans le runtime ciblé. Les imports Node/fetch déjà employés
par nos bundles ne constituent pas un contrat natif de propriété ou de profil.

Autres preuves produit :

- `opencode/missions/desktop-plugin.ts:9-18` conditionne tout Missions à
  `followPresence`, transport compris ; les leases expirent en 15 s
  (`opencode/desktop-plugin-presence.ts:4-13`).
- `opencode/missions-plugin.ts:100-127,155-235` dispose outils/contexte/outbox et
  refuse les exécuteurs capturés. Son journal utilise pourtant le storage natif.
- `opencode/automation-plugin.ts:468-473` exige exactement un backend propriétaire.
- `server/routes/mission-input.ts:45-110` reconstruit l'input depuis le snapshot,
  contrôle roots/projet/selection/locations, prend le fence, applique l'environnement
  complet puis admet prompt/synthetic avec la même connexion.
- `missions/exclusive.ts` protège les incarnations du bundle dans **un host JS**.
  `workspaces/worktree-session-evacuation.ts:17-93` est un fence **en mémoire**.
  Ni l'un ni l'autre n'autorise deux backends indépendants à muter sans coordination.
- `missions/control.ts:750-767` valide le projet des roots ; hors projet `global`,
  ce check ne valide pas à lui seul la location exacte de l'acteur enregistré.
- `workspaces/manager.ts:1074-1079` lit les settings à chaque send, mais
  `settings/yaml-doc-store.ts:51-77` cache le fichier après son premier load et
  remplace une erreur de lecture par `{}`. Ce comportement ne suffit pas pour
  promettre fraîcheur filesystem et fail-closed à un nouveau lecteur headless.
- L'audit `MISSIONS_RELIABILITY_REVIEW.md` (branche `preserve/missions-full-20261009`) prouve
  le couplage de disponibilité, pas une interruption native causée par quit.

L'ancien spike beta prouve storage partagé main/worktree et idempotence ; il ne
qualifie ni ce contrat headless ni les enfants actuels. Le minimum technique
produit 2.0.7 (`opencode/runtime-support.ts`) n'est pas automatiquement le minimum
de cette refonte. Ne fixer un nouveau minimum qu'après dépendance démontrée.

## 2. Comparaison des deux architectures

| Option | Avantage | Obligation non satisfaite actuellement |
| --- | --- | --- |
| Plugin seul + snapshot durable d'autorisation | Peu de processus ; journal et transport dans le daemon | Environment/inbox non exposés ; profil/host/WSL/settings frais et Git fences non natifs ; révocation et conflits desktop à reconstruire |
| Plugin durable + backend partagé persistant | Réutilise environment, auth, ownership, SDK et fences existants | Découpler lifecycle backend/window, restaurer autorités explicites, singleton et settings frais ; parité desktop |

**Ancienne recommandation, rejetée depuis le 7 octobre :** la deuxième option
envisageait un backend partagé persistant. Elle ne satisfait pas la cible native
décrite plus haut et ne doit pas guider la livraison. Ses objections à un plugin
seul restent des contrôles à qualifier côté OpenCode, pas une autorisation de
substituer le backend ou d'ignorer le profil et les writers concurrents.
Une snapshot contenant des variables figées est explicitement rejetée.

## 3. Invariants observables

1. Fermer/détacher le desktop n'est ni Pause, ni Stop, ni révocation. Aucun
   interrupt/evict/prompt/réaffectation n'est causé par ce détachement.
2. Installation/chargement du plugin est séparé de l'autorisation d'exécuter.
   Le journal, l'inspection, le contexte et l'écriture de preuves des admissions
   existantes ne suivent plus une lease desktop ; les nouvelles admissions oui,
   au sens d'une autorité durable valide, **pas** d'une présence de fenêtre.
3. Le coordinateur modèle choisit les tâches et transitions. Une échéance
   explicitement autorisée peut ouvrir un passage fini, mais aucun timer de
   silence, event ou reconnexion ne choisit ou dispatch une tâche métier à sa place.
4. Chaque prompt/synthetic Mission, Play et reprise ciblée reçoit un environnement
   complet fraîchement construit côté execution-host avant admission. Erreur =
   aucun send ; pas de cache « déjà appliqué », fallback ou replay alternatif.
5. Chaque send/control est lié au projet, à la mission, au profil et à la location
   **exacte** de ses sessions ; un projectID ou un préfixe de chemin ne suffit pas.
6. Pause/Stop désiré durable bloque les nouvelles admissions avant ses effets
   natifs. Des receipts partiels n'autorisent jamais une reprise automatique.
7. Report saved, input admitted, input consumed, travail terminé et objectif
   accepté sont des preuves distinctes. Unknown reste Unknown.
8. Tombstone, terminalité et révocation ne sont jamais effacées par migration,
   restauration de profil, changement de bundle ou retry d'une ancienne requête.

## 4. Autorisation durable révocable

Le backend conserve un registre protégé par profil, hors discovery root OpenCode
et hors projet. Le journal natif porte seulement une référence/receipt non secret.
Le registre est l'autorité ; metadata d'inbox et snapshot UI sont des indices.
Les outils modèles ne peuvent pas créer, changer de profil ou étendre un grant.
L'écriture du registre doit être atomique et exclusive par profil avec comparaison
d'époque ; `ctx.storage.set` n'offre pas ce CAS. Format/protocole host à qualifier,
sans ouvrir la DB OpenCode. Aucun grant n'embarque des valeurs d'environnement.

Un grant minimal est lié à :

```ts
type ContinuityGrant = {
  id: string; epoch: number; state: "active" | "revoked";
  profileIdentity: string; executionHost: HostIdentity;
  nativeStorageIdentity: string; projectID: string; projectCanonical: string;
  missionID: string; coordinatorSessionID: string;
  ownedRoots: readonly ExactRootIdentity[];
  capabilities: readonly ("mission-send" | "mission-control")[];
  issuedBy: string; requestID: string; policyVersion: number;
};
```

`HostIdentity` inclut host/distro sélectionné et namespace de chemins ;
`ExactRootIdentity` inclut directory physique validée, identité Git common-dir /
checkout lorsque Git est disponible, et règle explicite directory-only sinon.
L'autorisation d'une racine ne permet pas toutes les locations du même projectID.
Les nouvelles sessions ne peuvent être créées que dans ces racines autorisées,
avec IDs/contracts déterministes. Un changement de racine/profil exige adoption
explicite ; jamais « trouver un autre propriétaire disponible ».

La liaison storage/daemon doit rester exacte pendant la vie du service et lors
du Reprendre explicite après réouverture de CodeNomad, sans accepter une autre
DB au même endpoint. Une identité durable de namespace Mission, créée une
fois dans le storage natif et relue via challenge typé, est une piste **H**, pas
une API `ctx.storage.identity` existante. Comparer aussi les identités natives du
projet/coordinateur et les métadonnées authentifiées de connexion ; restaurer une
copie de DB ou une identité inconnue impose une réadoption. Ne pas lire/écrire la
DB OpenCode directement et ne pas réutiliser un secret de session-pruning.

Émission après action humaine authentifiée Play/adopter et CAS du journal.
Publier grant/receipt en deux étapes idempotentes : un grant incomplet n'admet
rien tant que le journal ne référence pas la même époque. Une référence native
sans grant valide est inerte ; une époque révoquée ne redevient pas active.
Révocation disponible sans fenêtre via une commande locale authentifiée dédiée
au backend, avec résultat durable. Pas de commande shell arbitraire ni RPC générique.

L'interface RPC native ne fournit pas d'identité HTTP de caller au handler.
Lier les mutations humaines privilégiées (grant/adoption/control) à une preuve
du backend : enveloppe signée limitée à méthode, mission, révision, requestID,
payload et époque, vérifiée avec une clé de confiance provisionnée par l'hôte.
Le choix/provisioning de cette vérification reste **H**, gate de sécurité du
prototype ; un booléen, un ID de profil ou le secret bridge dans un prompt est
interdit. La clé privée reste côté backend. Le plugin ne crée aucun grant par RPC.
Les opérations agent utilisent l'identité native du ToolContext et leur rôle,
pas un sessionID passé dans l'input. Le modèle de menace exclut un administrateur
local/plugin arbitraire déjà autorisé à exécuter du code dans le daemon.

Révocation bloque creation/send/resume, pas la conservation des preuves d'un
travail déjà admis. Pause suspend les admissions sans renouveler le grant ; Stop,
delete ou arrêt explicite de l'autorité le révoque. Un propriétaire perdu,
settings invalides ou conflit produit `authorization-blocked`, pas un changement
implicite de runState et pas une réussite.

## 5. Pipeline d'admission unique, desktop et headless

Appel seulement depuis une intention explicite modèle/humaine, une échéance
liée à une programmation humaine durable valide, ou la livraison d'un rapport
**déjà enregistré**. Le caller fournit un identifiant d'intention,
pas une URL, un profil, des variables ou un prompt libre de substitution.

1. Le plugin tient l'exclusion mutation projet pour préparer l'intention durable
   et appeler le transport. Le backend résout le grant par la mission et vérifie
   époque, preuve de caller, ownership et absence de conflit d'autorité.
2. Avec une connexion authentifiée acquise, lire snapshot RPC autoritaire et
   sessions natives. Reconstruire l'input exact via les builders de contrats,
   comparer IDs/text/metadata/delivery/resume, rôle et sélection agent/model/variant.
   Aucun switch d'un acteur occupé ; retry conserve la sélection contractuelle.
3. Résoudre directories physiques, inventaire worktree validé et identités Git,
   en intersectant grant, projet natif et acteur enregistré. Rejeter session
   déplacée, nested repo, alias étranger, symlink changé, root manquante ou
   historique workspaceID unsupported. Git absent n'élargit jamais aux siblings.
4. Prendre le fence partagé de mutation des identités cible **et** coordinateur
   (ancêtres/descendants inclus), et un verrou de send par session/autorité.
   Les autres envois CodeNomad utilisent ce même verrou environnement+admission.
5. Relire les settings du **profil lié** par un reader borné, validé, fail-closed,
   dans le backend. Pour modifications externes, relire la source autoritaire au
   send ; le cache actuel YamlDocStore et son fallback `{}` ne satisfont pas ce
   contrat. Pas de reload de location/daemon ni watcher de prompts.
6. Construire la snapshot complète avec `session-environment.ts` : base du
   processus d'autorité host + overrides, clés Windows case-insensitive ; en WSL,
   lecture bornée `env -0` dans la distro liée, sans PATH/HOME Windows. Suppression
   d'override restaure/enlève la clé. Exclure auth interne et variables storage.
   Un redémarrage change potentiellement la base process.env : le documenter ;
   ne pas prétendre lire un environnement OS global vivant inexistant.
7. Revalider sessions/locations/sélection, connexion actuelle, signal et époque
   après les awaits. Appliquer `session.environment`, rafraîchir le contexte Git
   advisory distinct (erreur redacted non bloquante), puis admettre avec le même
   client et messageID déterministe. Pas de prompt si environment échoue.
8. Enregistrer l'ACK d'admission ; une réponse perdue reste une intention ambiguë
   à réconcilier par messageID/inbox/transcript avant retry exact. Jamais choisir
   un autre transport ou créer une nouvelle tâche pour réparer cet ACK.

L'ordre de locks doit être fixé : exclusion native projet → gate backend du grant /
send-session → fence worktree. Le transport ne rappelle pas une mutation RPC
qui attend ce même verrou projet ; snapshot est un read. Révocation backend
prend le gate, retire l'époque et draine/annule les demandes non admises. Pause/
Stop sérialise son intention avec les sends dans l'exclusion native. Une requête
déjà admise avant ce point ne peut être désadmise par magie ; la contrôler via
interrupt/inbox et montrer les receipts. Ne pas annoncer une atomicité HTTP.

**Conflits live :** le desktop du même profil réutilise ce backend, pas un clone
de manager. Deux brokers possédant la même autorité sont une erreur de singleton.
Des profils différents revendiquant la même session bloquent les admissions,
même si l'un est headless ; pas de préférence au profil visible/dernier arrivé.
Le prototype doit soit partager l'exclusion/fence cross-profile au niveau host,
soit refuser l'ownership concurrente de la famille entière, mutations comprises.
Un fence en mémoire recopié dans deux processus ne suffit pas. Si ce gate n'est
pas implémenté, la continuité multi-profile est non supportée, fail-closed.

Les clients OpenCode externes et processus Git externes restent hors de ces locks.
Environment/selection sont session-scoped, pas atomicité par item de queue. Le
contrat garantit la politique **à l'admission CodeNomad**, pas l'isolation de toute
exécution ultérieure ; réutiliser un root actif peut affecter ses prochains shells.

## 6. Lifecycle, receipts et conservation des preuves

- Plugin durable : dissocier Missions de `followPresence` et de la discovery
  d'automatisation. Conserver provisioning content-addressed via `config.get`
  authentifié ; aucune écriture fréquente dans le discovery root observé.
  Installation consentie et disable explicite restent distincts de fermeture UI.
- Backend absent : tools/context/reads restent disponibles si la location native
  est chargée ; report est enregistré sans notification. Delegate/send/control
  retournent une indisponibilité structurée, sans transport direct alternatif.
- Rapport : valider admission/task/identité native/location enregistrée exacte,
  même sans backend. Ni possession du projectID ni lecture du snapshot suffisent.
  Si seul un intent dispatching est prouvé, conserver une preuve avec admission
  ambiguë plutôt que déduire un ACK natif. Le résultat de report distingue saved
  et notification pending : indisponibilité du transport ne nie pas la sauvegarde.
  Les rapports des travaux admis restent enregistrables pendant Pause/révocation.
  Pour Stop, prévoir une preuve tardive append-only sans réouvrir tâche/mission
  (changement explicite par rapport au refus actuel `control.ts:562`). Une
  tombstone n'est jamais recréée ; ses résultats restent dans les conversations.
- Pause : publier état désiré et liste immutable des cibles avant side effects,
  réserver les slots de receipts, interrupt `resume:false` pour roots enregistrés,
  garer notifications/reprises/admissions. Échec partiel = `control-pending`.
- Stop : terminal, même protocole, plus cancel des seuls items inbox corrélés à
  cette mission après reads frais ; ne pas annuler les autres inputs de l'acteur.
  Per-target ACK ne prouve pas l'arrêt d'un outil/processus/enfant externe.
- Retry controls : action utilisateur explicite avec requestID/revision d'origine,
  uniquement cibles pending de l'opération courante. Ancien start/pause ne passe
  jamais au-dessus d'un Stop ; Stop peut superséder un contrôle incomplet.
- Play : reprise explicite après contrôles résolus, même contrat/root/selection,
  IDs de synthetics stables, environnement frais ; pas de dispatch de dépendances.
- Outbox : autorisée uniquement pour rapports écrits non acknowledged d'une
  mission running/grant valide, sans contrôle pending. Batch/backoff bornés,
  mêmes IDs ; ce timer livre une notification, ne détecte pas un « stall » et ne
  reprend pas un coordinateur à partir du silence. Aucun runner de controls.

Arrêt de la machine/daemon/plugin/autorité n'est pas une garantie de liveness.
Dans l'étude historique du backend, son redémarrage devait authentifier la
connexion et le registre puis réconcilier carte/inbox/activité, sans prompt Play.
Cela n'est pas une exigence de reprise automatique du service OpenCode.
Les tasks dispatching et controls incomplets restent visibles pour retry explicite.

## 7. Enfants natifs, activité et reprise ciblée

Étudier `subagent` natif pour les travaux bornés du coordinateur ; garder roots
pour interventions humaines/réutilisation/durée indépendante. Ne pas appeler
session.create avec un parentID inventé. Associer task → invocation native →
session enfant → résultat par IDs natifs/receipt structuré, pas parsing du texte.

Gate séparé : mesurer environment et permissions hérités, background notification,
interrupt du parent, pause/stop et survie au detach/restart. Une admission d'enfant
via outil natif n'est pas interceptée par le pipeline HTTP CodeNomad actuel.
Sans preuve d'environnement et de contrôle, ne pas lui donner le même niveau de
garantie que le root headless ; garder ce mode privé ou afficher une capacité
explicitement limitée. Ne pas promettre Pause récursive ni relancer le parent
pour contourner un Stop lors d'une notification background native tardive.

Projection orthogonale : plan durable/runState, admission inbox, activité native
courante, attente Shell/subagent, Forms/permissions, dernier outcome et preuves.
`session.get().outcome` ne contredit pas `session.active()` running ; absence d'un
événement ou ancien badge working ne justifie pas Interrupted. Filtrer chaque
session/event sur son identité propre, pas `ctx.location` supposée universelle.
Après gaps/reconnect, relire ; absence de preuve = attention/unknown, jamais vert.

Reprise ciblée = action explicite et CAS sur observation native fraîche : soit
coordinateur à inspecter résultats déjà sauvés, soit acteur à fournir rapport
absent d'une admission identifiée. Pas de replay du brief de travail. Vérifier
running+grant, aucune control pending, erreur provider/Form/permission présentée,
aucun item corrélé déjà pending/consommé. Une seule intention par requestID,
bounded et traçable ; nouvel essai humain après ambiguïté, pas watchdog.

## 8. Interfaces minimales et adapters

Propositions d'interface, pas nouvelles API OpenCode. Un module profond
`MissionAdmission` concentre validation, ownership, environment, fences et receipt.
Son caller ne connaît ni discovery desktop ni valeurs d'environnement.

```ts
interface MissionAdmission {
  execute(intent: {
    missionID: string; intentID: string; grantEpoch: number;
    kind: "assignment" | "report-notification" | "control" | "targeted-resume";
    targetSessionID: string;
  }, signal: AbortSignal): Promise<AdmissionReceipt>;
}
interface ContinuityAuthority {
  adopt(input: AuthenticatedAdoption): Promise<GrantReceipt>;
  revoke(input: AuthenticatedRevocation): Promise<RevocationReceipt>;
}
```

`Authenticated*` est construit après authentification utilisateur côté backend,
pas un champ JSON libre. Un receipt distingue saved/pending/admitted/rejected et
porte intention/époque/messageID ou cible/opération native, sans variable secrète.
Résultats refusés structurés : ownership-conflict, authorization-revoked,
profile-unavailable, environment-unavailable, stale-connection, location-changed,
control-pending, ambiguous-admission ; détails natifs redacted.

Adapters privés réellement variables :

- NativeMissionRuntime : ctx storage/get/tools/context/RPC pour carte/rapports,
  HTTP client authentifié pour environment/inbox/activité/controls.
- ProfileExecutionHost : settings frais + host/WSL snapshot complète, réutilise
  `session-environment.ts`, jamais implémenté dans UI ou storage plugin.
- OwnedWorkspace : manager/inventaire validé/Git identities/fence unique existants,
  avec preuve d'exclusion multi-processus si nécessaire.
- AuthorityStore : registre durable par profil, époque, révocation et singleton ;
  test adapter mémoire pour courses/crash points, pas double journal de tâches.
- HostLifetime : attacher/détacher clients, persister explicitement l'autorité,
  Electron/Tauri/CLI ; aucune sélection de workflow, aucun contrôle automatique.

Le journal actuel reste l'autorité métier ; les events sont des invalidations.
Séparer les adapters de provisioning, automate desktop et admission. Aucun accès
HTTP/RPC arbitraire, pas de public API pour « exécuter une étape workflow ».
Conserver des quotas bornés ; compter les nouveaux events et réserver avant
publication les receipts nécessaires à Stop/cleanup. Une journalisation pleine
ne doit pas faire croire à un arrêt appliqué ni permettre un send sans intention.

## 9. Rupture de stockage, sans migration des anciennes Missions

Cette décision remplace la migration proposée initialement, conformément au choix
explicite de l'utilisateur. Le nouveau journal ne lit que
`codenomad-missions/v2/<project-token>` et la nouvelle autorité seulement
`codenomad-missions/authority-v2`. Un storage partagé contenant les anciennes clés
ne les importe, ne les modifie et ne les supprime jamais. Il n'existe pas de reader
legacy, de fallback, d'API `migrateLegacy` ni d'UI de migration.

Les nouvelles cartes nécessitent toujours une autorisation signée de leurs racines
exactes et un Play distinct. Une ancienne session native n'acquiert aucune autorité
sur ces cartes parce qu'elle partage un projectID, une location ou un titre.
L'isolation des clés ne prouve pas le quiescement d'un ancien bundle ni
l'exclusivité des admissions sur une session native partagée.

La **distribution** reste un contrat distinct : ne remplacer que l'entry managed
CodeNomad reconnue et respecter plugins utilisateur/désactivés. Le provisioning
doit vérifier le retrait effectif des anciens writers/outils avant qualification,
sans supposer qu'ils comprendront les nouvelles époques. Aucun `location.reload`
automatique : il annule les Forms/permissions. Aucun rollback ne révoque les
tombstones de la nouvelle génération ou n'en réactive un ancien fallback natif.

## 10. Essais historiques du backend, exclusivement isolés — non-acceptation native

CLI/config/home/DB/Git project/provider privés, toutes ressources possédées par
le fixture ; jamais le daemon utilisateur, missions #824 ou fermeture du desktop
actif. Assertions via les interfaces réelles et provider déterministe.

| Scénario | Preuve requise |
| --- | --- |
| Dernière fenêtre puis desktop quitté pendant tour/outil | Aucun interrupt/evict ; contexte/tool report au tour suivant ; provider reçoit le report ; backend seul reste autorisé |
| Backend retiré/crashé | Journal/report encore sauvables ; nouveaux sends refusés ; ACK lost visible ; aucun fallback direct |
| Restart plugin/backend privé | Même storage/grant valide après auth ; read-only reconcile ; aucune task/root/Play créé à l'activation |
| Report coordinateur busy/idle | Un messageID natif ; admission distincte de consommation observée dans le provider ; aucun retry après ACK |
| Per-send settings edit/removal, host/WSL | Snapshot complète fraîche, bon casing/host, exclusions de secrets ; override supprimé non retenu |
| Settings corrompus/inaccessibles ou environment call échoue | Zéro prompt/synthetic ; pas de `{}`/stale fallback ; logs/errors redacted |
| Révocation pendant read/environment/send, grant torn write | Ordre linéarisé des admissions/intentions ; anciennes époques refusées ; état pending honnête après ACK perdu |
| Deux profils / deuxième broker / desktop réattaché | Ambiguïté refusée ; singleton et fence réellement partagés ; pas de profil choisi au hasard |
| Worktree remove/move, nested repo, symlink, Git perdu/revenu | Admission bloquée/drainée ou identité exacte conservée ; aucun élargissement de l'autorisation |
| Pause/Stop à chaque crash point, retry ancien Start | État désiré avant effets, receipts partiels, only pending retry ; Stop terminal, inbox mission seule annulée |
| Late report/notification après Pause/Stop/delete | Preuve conservée selon politique, aucun wake/reopen ; pas de résurrection de tombstone |
| Native/background/ordinary session finit en absence UI | Activité/outcome/projection exacts ; pas de faux Interrupted, pas de timer stall |
| Modèle sans rapport/provider error/Form/permission | Attention sans réussite ; reprise ciblée explicite idempotente, pas replay brief ni contournement blocage |
| Subagent foreground/background et parent interrompu | IDs/result associés ; environment/permissions mesurés ; contrôle/survie réellement observés, garanties limitées sinon |
| Anciennes clés et ancien writer, nouvelles cartes | Aucun import/lecture/mutation legacy ; octets préservés ; nouvelles cartes/époques isolées ; quiescement natif vérifié séparément ; no auto-start |
| Événement manqué/location rechargée/namespace différent | Snapshot autoritaire, unknown honnête ; DB différente refusée, aucun accès direct SQLite |
| Electron et Tauri privés, zéro fenêtre | Lifecycle backend identique, automations indisponibles, exit autorité explicite ne stoppe pas OpenCode |

L'étude documentaire initiale n'exécutait pas ces gates. Depuis, plusieurs preuves
isolées sont implémentées et répétées ; consulter `MISSIONS_REFACTOR_VALIDATION.md`
pour leur périmètre exact. Aucun résultat partiel ou ancien ne qualifie à lui seul
la chaîne headless entière ou le nouveau contrat packagé.

## 11. Risques de l'étude historique et proposition écartée

**Bloquants de l'ancienne proposition backend :** lifecycle persistant sans fenêtre aux deux hosts ;
autorité singleton et exclusion cross-profile ; lecteur settings fail-closed ;
authentification des mutations privilégiées RPC ; liaison nativeStorageIdentity ;
coexistence/rollback de vieux writers. Aucun n'est présenté comme déjà résolu.

**Limites conservées :** native location/plugin peut être unloadée, daemon/OS peut
tomber ; inbox/env/selection ne forment pas une transaction ; ACK n'est pas lecture
modèle ; externes hors fences ; Pause ne suspend pas exactement les subprocessus
et n'offre pas encore de contrôle récursif ; enfant peut ne pas hériter environment.

Cette étude proposait un prototype **privé** avec backend unique sans fenêtre,
pour comparer grant/revoke, settings frais, admission et contrôle. Cette voie est
écartée comme solution de l'autonomie demandée : les protections qu'elle listait
doivent être qualifiées dans le service OpenCode, sans backend CodeNomad persistant.

### Sources consultées

- `AGENTS.md`, `dev-docs/MISSIONS.md`, `dev-docs/SESSION_ENVIRONMENT.md`,
  `dev-docs/MISSIONS_RELIABILITY_REVIEW.md`, `dev-docs/MISSIONS_RUNTIME_SPIKE.md`
  (ces deux derniers uniquement sur la branche locale `preserve/missions-full-20261009`).
- Chemins produit abrégés ci-dessus sous `packages/server/src/` ; déclarations
  installées `@opencode/client` / `@opencode/plugin` 2.0.21 et contract check
  `.opencode/checks/codenomad-missions.ts` (lecture, pas exécution). Les
  documents de spike/revue et ce contract check sont conservés sur la branche
  locale `preserve/missions-full-20261009`, hors de l'arbre produit.
- https://opencode.ai/v2/docs/build/plugins
- https://opencode.ai/v2/docs/build/plugins/rpc
- https://opencode.ai/v2/docs/tools
