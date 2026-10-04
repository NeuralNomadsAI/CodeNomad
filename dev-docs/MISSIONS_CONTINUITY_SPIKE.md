# Missions : spike privé de continuité native 2.0.21

Qualification exécutée le 2026-10-01, document finalisé le 2026-10-02.
Livrables : `scripts/test-missions-continuity-spike.mjs` et ce document.
**Prototype terminé, pas refonte produit implémentée ni sécurité de production validée.**
Aucune modification produit, aucun commit/push/publication, aucune fusion de #673.

## Conclusion opérationnelle

OpenCode 2.0.21 sait poursuivre une racine, exécuter un enfant natif, terminer un
shell background et réveiller un parent/coordinator **sans desktop**. Le desktop
ne doit donc pas être le propriétaire de la continuité des contrats/rapports.
Le plugin Missions actuellement livré retire pourtant ses outils/contexte à la
dernière présence ; ses exécuteurs capturés refusent ensuite toute utilisation.

Recommandation : coordinateur racine durable, enfants natifs pour les travaux
bornés appartenant à ce seul coordinateur, racines pour les acteurs indépendants
ou réutilisables. **Ne pas activer le mode enfant background sans contrat Pause/
Stop qualifié** : sa notification native réveille un parent explicitement interrompu.
La carte métier reste distincte de l'exécution native ; aucune seconde file de
travail n'est nécessaire à la preuve.

## Isolation et reproduction

```powershell
node scripts/test-missions-continuity-spike.mjs
```

Le script n'accepte que l'exécutable absolu assigné :
`C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe`.
Il le lance uniquement avec `serve --hostname 127.0.0.1 --port 0 --print-logs`.
La version est lue par HTTP authentifié sur **cet enfant**, pas par discovery ni
par une commande CLI susceptible de démarrer le service partagé.

- Racine aléatoire sous `C:/Users/Admin/AppData/Local/Temp/opencode/` ; projet,
  HOME/USERPROFILE/APPDATA/LOCALAPPDATA, config, XDG et `OPENCODE_DB` privés.
- Variables OpenCode/CodeNomad/XDG héritées retirées, découverte de configuration
  projet désactivée, models fetch et update désactivés.
- Provider OpenAI-compatible HTTP loopback déterministe, modèles `fixture/fixture`
  et `fixture/child`, aucune requête à un provider utilisateur.
- `WorkspaceManager` reçoit une factory de service qui ne retourne que l'endpoint
  enfant privé. Son bridge authentifié et sa présence Missions sont privés.
- Le vrai `mission_delegate` admet une racine via ce bridge avant détachement.
  Puis le manifest du bridge est retiré, le serveur bridge fermé et la dernière
  présence Missions retirée, pendant un appel modèle retenu par le provider.
- Le script n'ouvre/ferme pas l'application, ne découvre/redémarre/arrête pas le
  daemon partagé et ne modifie jamais ses fichiers. Le cleanup tue seulement
  son handle de processus enfant. Les artifacts privés sont conservés.
- Budget de 160 requêtes provider, deadline globale 180 s, attentes bornées
  20–30 s et watchdog qui termine seulement l'enfant privé. Les lectures de
  polling sont celles du test hôte, pas des prompts de relance des agents.

Le plugin de preuve `continuity.spike` est écrit dans la racine temporaire. Il
fournit des contrats en storage natif, un `spike_report` de démonstration, une
sonde de snapshots et une enveloppe du **vrai** exécuteur `subagent`. Il ne
remplace pas `subagent` par un faux enfant. Les appels viennent des réponses SSE
du provider et passent par le runner natif et ses permissions.

## Artifacts vérifiables

Run final : **PASS**, sortie naturelle du script, serveur **2.0.21**, **48
requêtes provider primary**, **22 sessions natives**, **556 événements capturés**.

Racine exacte :
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-continuity-utkc11/`.

Autres runs complets PASS après ajout du bridge réel :
`missions-continuity-Gtcifz` (avant derniers garde-fous/deadline) ; les premiers
runs et ajustements du fixture sont conservés séparément, jamais présentés comme
des validations produit.

| Artifact relatif à cette racine | Contenu |
| --- | --- |
| `results.json` | Assertions, sessions, états natifs, rapports/bindings et index des requêtes |
| `requests.json` | Bodies HTTP effectivement reçus par le provider, sessionID/kind et horodatage |
| `events.json` | Événements natifs, IDs d'appels/enfants, séquences durables quand présentes |
| `transcripts.json` | Messages natifs bornés de chaque session, états d'outils et metadata synthétiques |
| `openapi.json` | Contrat servi par cet enfant 2.0.21, pas une supposition de client/documentation |
| `catalog.json` | Outils et méthodes réellement exposés au plugin |
| `spike-plugin/index.ts` | Source exacte du plugin de preuve généré |
| `serve.log`, `fixture.db` | Logs du seul enfant et stockage natif privé |
| `project/background-finished.json` | Preuve filesystem indépendante de fin du shell background |

Les index ci-dessous sont des index zéro de `requests.json`. Ce fichier fournit
la preuve de consommation des messages par une requête modèle. Un ACK HTTP,
`wait()` ou un badge ne sert jamais seul de preuve. Le provider est déterministe :
cela ne démontre pas qu'un LLM non déterministe comprend ou respecte un contrat.

## Matrice des capacités et risques mesurés

| Scénario | Observation 2.0.21 et preuve | Limite / implication |
| --- | --- | --- |
| Admission racine via bridge, puis disparition bridge/présence | Mission privée `msn_9c5e563517dbbdc8a1316e5d`, acteur `ses_b78939861ee9c6dcd5ec1c8c4b`, admission `msg_ed901d5f3ea1aa53c176444c2db5`. Requête 3 consommée avant detach ; requête 5 après detach, outcome racine `succeeded`, sans `parentID`. | Continuité du runner natif, pas achèvement automatique de la tâche Missions actuelle. |
| Rapport root → coordinator sans desktop | `spike_report` écrit `report/root-work`, puis `session.synthetic(delivery=queue,resume=true)` avec ID stable `msg_aaaaaaaaaaaaaaaaaaaaaaaa`. Un seul message corrélé, réellement consommé par le coordinator à la requête 7. | Rapport **de prototype** ; transport/context/storage durables ne sont pas encore livrés par Missions. Les fences/profil de production restent à concevoir. |
| Exécuteurs Missions capturés après disposal | Sondes capturées `mission_inspect` **et** `mission_report` retournent `CodeNomad Missions is no longer available`. Un appel modèle déjà parti avec `mission_inspect` termine son outil en erreur (requêtes 0/6). | Confirme le refus applicatif `assertActive`, pas une interruption native automatique au quit. |
| Snapshot natif de tool + prochain contexte | Requête 2 possède `spike_captured` et `DISPOSABLE_CONTEXT`. Après disposal des registrations, l'exécuteur déjà capturé finit ; requête 4 voit son résultat mais plus son outil, son contexte ni `mission_inspect`. Le coordinator perd aussi son contexte Missions initial entre 1 et 7. | Retirer un outil n'annule pas son exécuteur capturé ; fermer sur un flag mutable peut néanmoins le rendre inutilisable. |
| Enfant foreground réel | Parent `ses_f067e3183ffeWV6dx2VJHXe4Xr`, enfant `ses_f067e3160ffeZiYYQiGSQqF2RS`, `parentID` exact, agent `spike_child`, requêtes enfant 9/10 sur modèle `child`, résultat natif puis consommation parent 11/12. | `wait(parent)` attend ici l'outil foreground, pas une garantie générale sur toute la descendance. |
| Contrat et rapport enfant sans parsing | `fg_call` lié par progression structurée à l'enfant ; son **premier** contexte provider (9) contient `taskKey=fg-work`. Rapport `report/fg-work` porte childID/callID/coordinatorID et est consommé par le parent. | Le binding synchrone est prouvé ; atomicité crash/storage entre création, progression, binding et admission n'est pas qualifiée. |
| Continuation du même enfant | `sessionID` dans le vrai tool : requêtes parent 13/15, enfant 14 ; un seul `session.created` enfant pour ce parent. | Ce n'est pas un nouvel acteur racine ni une migration de parent. |
| Continuation depuis un autre parent | Outil en erreur : `is not a child of the current session`, requêtes 16/17 ; zéro requête supplémentaire de l'enfant. | Ne pas réutiliser un enfant entre coordinateurs comme une racine. |
| Background child, parent idle | Outil de lancement `completed`, metadata de l'enfant `status=running`. Parent absent de `session.active`, enfant présent. Après release, enfant 20/21 ; rapport parent 22 puis notification native 23. | Le parent idle/succeeded n'implique pas fin du travail ; le statut d'un ancien outil n'est pas l'activité actuelle. |
| Fin shell background sans desktop | Requêtes 24/25 puis notification native consommée en 26, metadata `source=shell`, shellID/jobID, `state=completed`, `exit=0` ; fichier indépendant `{done:true}` écrit. | La réussite d'une session et celle d'un job background sont deux dimensions. |
| Permission subagent parent deny | Appel en erreur, aucune création d'enfant, requêtes 27/28. | Le lancement natif conserve la décision de permission ; l'enveloppe ne doit jamais la court-circuiter. |
| Agent primary-only | `spike_primary` existe au catalogue mais son lancement enfant échoue, sans enfant, requêtes 29/30. | Rôle de mission ≠ agent ; choisir un agent subagent/all configuré. |
| Héritage des règles de session | Parent deny `shell:*` ; premier appel enfant 32 ne reçoit **aucun** outil shell. | Règles héritées à la création ; changement de règles d'un parent après création non testé. |
| Interrupt parent foreground | Requêtes 34/35 retenues ; interrupt parent aboutit à parent **et** enfant `interrupted`, enfant absent d'active ; outil erreur `aborted`. | Preuve à une profondeur seulement, pas suspension récursive arbitraire. |
| Interrupt parent background | Parent devient `interrupted`, enfant reste actif et finit `succeeded`. Sa notification le réveille : requête parent 39, outcome parent final `succeeded`. | **Risque critique Pause/Stop** : interrupt du seul coordinateur n'est ni révocation ni barrière de notifications. |
| Interrupt explicite de l'enfant | Enfant `interrupted` ; notification parent metadata `state=cancelled`, consommation en 43. | Ne pas confondre le vocabulaire de notification `cancelled` avec l'outcome session `interrupted`. |
| Erreur provider d'un enfant background | Requête enfant 46 reçoit HTTP 400 déterministe ; outcome enfant `failed`, notification parent metadata `state=error`, réellement consommée en 47. | La notification ne transforme pas un résultat rouge en succès de tâche, même si le parent finit son tour normalement. |

Les indices de requêtes concurrents peuvent varier sur un autre run ; les
assertions relient les identités natives et les contenus, pas ces indices fixes.

## Contrats réellement disponibles

### Agents et création

- Configuration privée V2 `agents.spike_child.mode=subagent`, description,
  `system` et modèle `fixture/child` ; catalogue lu par `agent.list`.
- Le tool subagent annonce les agents subagent/all, pas le primary-only. L'appel
  direct invalide échoue même si un provider force le nom.
- HTTP `/api/agent` et `/api/agent/{agentID}` sont des lectures. Le contexte plugin
  expose `list/get/transform/reload`, **pas `agent.create`**. Ne pas inventer une
  API de création dynamique d'agents pour chaque rôle.
- Le vrai schéma de `POST /api/session` accepte `id/title/agent/model/location/
  metadata/permissions`, avec `additionalProperties=false`, **sans `parentID`**.
  `session.create({parentID: ...})` n'est donc pas un contrat supporté de création
  arbitraire d'enfant. Les enfants prouvés sont ceux du vrai tool `subagent`.
- Le tool accepte `agent/description/prompt`, `background`, `sessionID` de
  continuation et un override `model` string. Le modèle configuré de l'agent est
  prouvé par le provider ; overrides/variants non testés ici.
- Pas d'outil LLM natif universel de rapport/send intersession identifié dans ce
  catalogue. **L'API/plugin `session.prompt` et `session.synthetic` existe**, et
  constitue le transport root → coordinator prouvé par `spike_report`.
  L'outil de rapport métier reste une extension, pas une primitive native cachée.

### Association enfant ↔ contrat

Le wrapper du prototype conserve les options de permission et l'exécuteur natif
capturé par `tool.transform(editor.update('subagent', ...))`.

1. Contrat pré-enregistré en storage par ID d'invocation natif (ex. `fg_call`).
2. Exécuteur natif crée l'enfant, puis appelle `context.progress` avec
   `{sessionID: childID, status: running}`.
3. Le wrapper valide `child.parentID === callerSessionID` et l'identité du
   coordinator attendue, écrit binding et contrat enfant **avant** de relayer
   la progression et avant le premier appel modèle enfant.
4. Hook `session.context` lit le contrat de cet enfant et l'injecte au modèle.
5. Résultat d'outil : `state.metadata.sessionID/status`. Notification background :
   metadata synthétique `{source: subagent, childID, agent, state}`.

`session.created` donne `parentID` mais pas le callID ; il ne suffit pas pour
associer plusieurs launches concurrents. La progression n'est pas elle-même un
événement durable avec séquence : le wrapper doit persister son binding, et la
reprise doit réconcilier l'état d'outil natif. Le prototype utilise des callIDs
choisis par le provider déterministe ; le produit doit enregistrer le contrat
dans la même invocation métier, **pas deviner son callID à l'avance**.
Ni regex sur `<subagent ...>`, ni parsing d'une description/prompt n'est utilisé
pour cette association. Les marqueurs de prompts ne servent qu'au routage du
provider déterministe du fixture.

## Recommandation d'architecture hybride

1. **Coordinateur racine** : identité humaine, journal métier et permission
   durable du run, indépendants du renderer/backend desktop.
2. **Child natif pour unité bornée** : intégrer la création réelle par tool,
   binding invocation/contrat/progression et notification/result natifs. Choisir
   foreground par défaut lorsque son rattachement/cancellation correspond au
   contrat de tâche ; background uniquement avec politique explicite.
3. **Root pour acteur indépendant/réutilisé** : contrat durable, input natif
   queue, rapport explicite corrélé ; préserver le profil et les fences de
   propriété/worktree/environnement sans choisir arbitrairement un backend.
4. **Noyau de coordination toujours chargé** : contrats, lecture de contexte,
   écriture de rapports et enregistrement des résultats doivent survivre au
   detach. Les capacités desktop restent séparées et fail-closed. Le native
   snapshot conserve les exécuteurs : concevoir explicitement leur révocation.
5. **Projection séparée** : plan/admission, activité `session.active`, outcomes
   natifs, job background/enfant, rapport métier et consommation de notification.
   Un outil de launch terminé ne clôt pas le child ; `succeeded` du parent n'est
   pas l'état de toute la mission. Unknown doit rester Unknown.
6. **Pause/Stop avant background** : suivre et interrompre explicitement les
   enfants/jobs appropriés, traiter les notifications déjà admises/en vol et
   leur capacité native à réveiller un parent interrompu. Aucun hook documenté
   de veto d'admission synthetic n'est établi ici ; `prompt` ne couvre pas les
   synthetic. Ne pas promettre un stop récursif ou un simple filtre UI.

Plus petit prochain gate : fixture de **révocation durable Pause/Stop**, pendant
un enfant background retenu et une notification de fin en vol, puis reprise
ciblée autorisée. Exiger zéro nouvelle consommation modèle non autorisée ; ne
pas appeler ce gate vert sur la seule réception d'un ACK interrupt.

## Garanties non établies

- Restart/crash du daemon, restauration d'exécuteurs background après reboot,
  reprise exacte de l'admission en vol, binding transactionnel et concurrence de
  plusieurs invocations enfants. Aucun test de stockage utilisateur.
- Profil d'environnement hérité/modifié entre child et parent ; deux propriétaires,
  worktree déplacé, autorisation durable sans backend et migration des anciennes
  missions. Le bridge d'admission privé utilise les fences produit existants,
  mais le `spike_report` démonstratif n'est pas leur remplacement sécurisé.
- Journaling/report idempotent de production, outbox, révision du contrat,
  relecture durable après reload, annulation de plusieurs niveaux de descendants,
  Forms/permissions en attente et nested subagents.
- Quit réel Electron/Tauri ; le test reproduit la disparition de bridge/présence,
  sans arrêter l'application utilisateur. Un résultat natif sans rapport demeure
  un manque de preuve métier, pas une tâche automatiquement completed.
- `spike_report` est volontairement minimal : écriture storage puis synthetic,
  sans transaction, outbox ou retries. Une preuve de capacité ne fournit pas
  d'exactly-once ni de contrat de sécurité pour la refonte.

## Sources consultées

### Régression produit ajoutée après le prototype

Run privé du 2026-10-02 :
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-continuity-xdKlwn/results.json`.
Le runner appelle maintenant les vrais modules `missions/activity.ts` et
`native-recovery-observation.ts` sur le parent idle/succeeded avec son enfant
natif background retenu. La projection affiche `background` et la reprise
refuse avec `recovery-busy`, sans send. Les capacités prototype et leurs limites
restent inchangées ; aucun background Mission n'est activé par cette régression.

Cette qualification a révélé une différence des mocks : `session.list` 2.0.21
émet un curseur `next` pour toute page non vide, même courte. L'inventaire partagé
`native-session-family.ts` suit donc ces curseurs jusqu'à une page terminale
autoritaire, avec plafond de 32 descendants/66 reads et deadline, refus des
cycles, identités déplacées/étrangères et inventaires incomplets. Il ne confond
pas présence d'un curseur avec preuve de descendants supplémentaires. Le stub
settings privé fournit désormais le reader d'environnement d'admission frais.

- `AGENTS.md`, `dev-docs/MISSIONS_RELIABILITY_REVIEW.md`.
- Patterns d'isolation de `scripts/test-missions-native.mjs` ; lifecycle,
  bridge, `missions-plugin.ts` et types du client installé.
- Documentation V2 exclusivement :
  https://opencode.ai/v2/docs/build/plugins,
  https://opencode.ai/v2/docs/tools,
  https://opencode.ai/v2/docs/agents,
  https://opencode.ai/v2/docs/api,
  https://opencode.ai/v2/docs/config.
- Le contrat `openapi.json`, les snapshots outils/provider et les états servis
  par **l'enfant privé 2.0.21** restent la preuve de cette version. Aucune API V1
  ni API intersession imaginée n'est utilisée.
