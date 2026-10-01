# Issue #824 — continuité de l'audit performance

- Date : 2026-10-01
- Baseline examinée : `366830f6` (`origin/dev`)
- Audit repris : worktree `audit-resume-integration`, baseline `47f9e43e`

## Portée et niveaux de preuve

Diagnostic en lecture seule du produit. Aucun daemon, profil, desktop ou stockage
utilisateur n'a été démarré ou modifié. Le seul exercice exécuté ici est un micro-
benchmark local de la primitive d'authentification, sans réseau ni fichier partagé.

Les affirmations ci-dessous portent explicitement l'un des niveaux suivants :

- **Mesure exécutée** : observation chronométrée pendant cette mission ou mesure A/B
  conservée par l'audit précédent avec protocole et artefact décrits.
- **Reproduction fonctionnelle antérieure** : assertion rouge/verte exécutée par
  l'audit précédent, sans nouvelle mesure de latence dans cette mission.
- **Analyse statique** : chemin de code observé ; coût ou impact encore à mesurer.
- **Hypothèse** : mécanisme plausible à tester, pas un défaut confirmé.

Les diagnostics spécialisés de compactage et de transport HTTP Linux/Windows sont
hors de cette carte. Les priorités proposées sont transversales et complémentaires.

## Continuité entre l'audit et la baseline courante

L'audit précédent n'était pas un commit : `audit/resume-integration` est toujours à
`47f9e43e` avec ses corrections en fichiers modifiés/non suivis. Entre `47f9e43e` et
`366830f6`, les 16 commits de `origin/dev` concernent notamment Files, responsive,
usage, OpenCode 2.0.20/2.0.21 et Tauri macOS. Ils ne constituent pas l'intégration
générale de l'audit.

Contrôle objet Git effectué : les dix fichiers sentinelles suivants ont exactement
le même blob à `47f9e43e` et à `366830f6` :

| Surface auditée | Blob encore présent à `366830f6` | État |
| --- | --- | --- |
| rendu des tâches imbriquées, `packages/ui/src/components/tool-call/renderers/task.tsx` | `dee90df8560b83958dbf6d6f7c40e013bbdb289f` | correction audit absente |
| distribution SSE UI, `packages/ui/src/lib/server-events.ts` | `29d8342071fee3fc1ab3a2f7bc71c847bc68f8a8` | correction audit absente |
| itérateurs/relay OpenCode, `packages/server/src/workspaces/opencode-service.ts` | `ad8cfbaa00ebce3cc47e9a70217244217cb8b3dd` | correction audit absente |
| Speech/Sidecars, `packages/ui/src/stores/speech.ts`, `sidecars.ts` | `45832e4c…`, `d52a8d5f…` | corrections audit absentes |
| fermeture multi-fenêtres Electron, `packages/electron-app/electron/main/multiwindow-lifecycle.ts` | `59995dfd1b36cc4d4eee742c4798477cb5b59b9b` | correction audit absente |
| historique pruning, `packages/server/src/opencode/session-pruning/history-database.ts` | `37318db55235fb9b50ffd2efb60a154495f6967a` | correction audit absente |
| polling provider, `packages/ui/src/components/provider-auth/provider-manager-modal.tsx` | `c1e977a70acaa649ab81d3dba5d6019c693f4f09` | correction audit absente |
| lecture conversation, `packages/ui/src/stores/conversation-speech.ts` | `67a12d80c070874f222b24b7b44dfd400beb51a6` | correction audit absente |
| auth manager, `packages/server/src/auth/manager.ts` | `4e234ace6fc1b94ebb8543617d7d8048239135db` | correction audit absente |

`packages/server/src/server/http-server.ts` a changé dans #811/#814, mais la
comparaison avec le worktree d'audit montre encore un delta : ces commits ne sont
pas l'intégration de la composition preview/redaction auditée.

### Ce que l'audit avait réellement qualifié

- **Rendu imbriqué** : mesure A/B historique sur 80 étapes `read` de 8 000 caractères,
  30 échantillons par variante. Médiane main-thread `369,98 -> 20,64 ms` par delta,
  remounts DOM `80 retirés + 80 insérés -> 0`; 80 snapshots natifs restent. Protocole,
  variance et artefact dans `AUDIT_RENDERING_COST.md:40-80`. Deux assertions rouges
  sur la source baseline et 63 tests navigateur verts sur la correction
  (`AUDIT_RENDERING_COST.md:128-145`). **Mesure historique, pas rejouée sur 366830f6.**
- **Isolation événements** : 50 tests SDK/HTTP/relay/server et 4 régressions Chromium
  verts sur la correction ; un destinataire relay lent n'y bloque pas le destinataire
  rapide (`AUDIT_UPSTREAM_DEV_2026_09_30.md:193-208`). La correction isole exceptions
  et fins locales d'itérateur, pas un callback UI qui consomme le CPU.
  **Reproduction fonctionnelle antérieure, pas mesure de latence.**
- Les correctifs Speech/Sidecars, provider polling, pruning/history et fermeture
  concurrente ont eux aussi été qualifiés dans le worktree d'audit, mais aucun signal
  ne permet de les compter comme intégré à `366830f6`. Ils restent des correctifs de
  robustesse/lifecycle, pas les premières reproductions performance de #824.
- L'audit a réfuté dans son fixture réel le montage de tout le transcript/timeline et
  le DOM non borné des gros outputs (`AUDIT_RENDERING_COST.md:83-100`). Ne pas rouvrir
  ces trois pistes sans nouvelle preuve contraire.

## Priorités résiduelles bornées

### P1 — Rejouer puis intégrer la correction de rendu des tâches imbriquées

**Niveau : mesure historique confirmée ; correction absente de la baseline.**

Le code courant recrée le rendu complet via un `createMemo` dans
`task.tsx:54-99`, et vide encore les clés à `task.tsx:236-243` pendant une
réindexation. Chaque `ToolCall` clone aussi profondément son entrée à la création et
à chaque changement de versions (`packages/ui/src/components/tool-call.tsx:630-640`).
Cela correspond exactement au chemin mesuré par l'audit. Le coût résiduel des 80
`structuredClone` est lui-même mesuré, mais son optimisation n'est pas validée.

**Plus petite prochaine reproduction :** récupérer sans l'élargir le fixture
`scripts/test-render-cost-audit.mjs` et `packages/ui/tests/browser/render-cost.test.ts`
du worktree audit, exécuter d'abord l'override rouge sur le blob
`dee90df8560b…`, puis A/B sur `366830f6` et sur la correction auditée. Conserver les
assertions d'identité DOM comme gate ; ne pas introduire de seuil timing CI instable.

### P2 — Isoler les abonnés SSE et mesurer le temps de distribution

**Niveau : défaut fonctionnel reproduit antérieurement ; risque CPU statique.**

La baseline distribue ouverture, événements et statuts avec des `Set.forEach`
synchrones sans frontière par callback (`packages/ui/src/lib/server-events.ts:69-76`,
`:151-170`). L'audit a confirmé qu'une exception d'un abonné supprime les abonnés
suivants et peut interrompre un restart. Cela peut ressembler à une application figée
alors que le transport reste vivant. En revanche, aucune preuve ne montre encore un
callback lent bloquant durablement le renderer ; l'audit précise que ce cas n'est pas
isolé.

**Plus petite prochaine reproduction :** réimporter le fixture
`event-subscriber-isolation.test.ts`, prouver rouge/vert sur l'exception, puis ajouter
un lot borné d'événements avec un abonné instrumenté volontairement lent. Mesurer
durée de `dispatchBatch`, retard d'un `requestAnimationFrame` sentinelle et abonnés
appelés. Le premier correctif utile reste la petite barrière `try/catch` déjà auditée ;
une planification asynchrone ne doit être envisagée qu'après mesure car elle change
l'ordre/la sémantique Solid `batch`.

### P3 — Retirer `scryptSync` du thread HTTP d'authentification

**Niveau : mesure exécutée et analyse du chemin HTTP.**

`verifyPassword` et `hashPassword` utilisent `crypto.scryptSync`
(`packages/server/src/auth/password-hash.ts:23-28`, `:37-48`). Le POST login appelle
ce chemin synchroniquement via `AuthManager.validateLogin`
(`packages/server/src/auth/manager.ts:74-79`; route dans
`packages/server/src/server/routes/auth.ts:99+`). Pendant ce calcul, le thread Node
partagé ne sert ni autres requêtes ni événements des autres sessions.

Micro-benchmark exécuté sur Windows, Node `v25.2.1`, paramètres de production
`N=16384,r=8,p=1`, 10 vérifications séquentielles : médiane **19,56 ms**, plage
**19,12–21,60 ms**. C'est une durée de blocage de primitive, pas une mesure Fastify,
desktop ou charge concurrente. Une rafale de tentatives multiplie directement ce
blocage ; l'impact réel et les limites de taux ne sont pas qualifiés ici.

**Plus petite prochaine reproduction :** fixture Fastify inject/loopback isolée avec
un heartbeat de latence pendant une rafale bornée de logins invalides. Mesurer p50/p95
du heartbeat et durée login avant/après passage à `crypto.scrypt` asynchrone, en
conservant comparaison constante, paramètres et réponses d'auth identiques. Couvrir
aussi `setPassword`, qui appelle `hashPassword` sur le même thread.

### P4 — Borner le coût renderer + disque de la persistance d'état client

**Niveau : analyse statique ; hypothèse de freeze à reproduire.**

Le renderer recapture l'état après 100 ms d'activité
(`packages/ui/src/lib/hooks/use-app-session-capture.ts:124-168`), puis la couche état
reprogramme une sauvegarde après 250 ms (`packages/ui/src/stores/client-state.ts:10`,
`:85-128`, `:139-145`). Chaque sauvegarde normalise, encode tout le graphe et contrôle
jusqu'à 4 096 partitions / 256 MiB autorisés
(`client-state-partitions.ts:8-15`, `:188-220`). Côté Electron, chaque mutation clone
l'enveloppe avec `JSON.parse(JSON.stringify(...))`, la resérialise, l'écrit, rename et
fsync le répertoire (`packages/electron-app/electron/main/client-state.ts:628-692`).
Le chemin normal est asynchrone côté disque ; les migrations/cross-host utilisent
encore des opérations sync, mais surtout au démarrage/récupération, pas à chaque save.

Aucun profil de gros état ou disque lent n'a été exécuté : **ne pas décrire cette
piste comme cause confirmée**.

**Plus petite prochaine reproduction :** fixture Electron/module isolée générant des
états réalistes à 1, 16, 64 et 256 MiB, avec churn de draft/layout à 10 Hz. Instrumenter
séparément `encodeClientSnapshotV2`, IPC, file d'écriture, retard event-loop renderer
et main, taille/compte de partitions et durée de flush. Simuler un writer lent injecté,
sans disque utilisateur. Le résultat dira s'il faut du partage structurel, un worker,
une fréquence moindre ou uniquement une borne plus basse.

### P5 — Mesurer la rafale périodique de réconciliation multi-instance

**Niveau : analyse statique ; hypothèse de contention réseau/réactive.**

Toutes les 30 secondes, `App.tsx:276-289` parcourt simultanément toutes les instances
`ready`. Même sans session active, `runPendingRequestLiveness` finit par
`syncPendingRequests` (`packages/ui/src/stores/instances.ts:864-887`), lequel lance en
parallèle scans permissions et Forms, avec jusqu'à trois reprises de stabilisation
(`instances.ts:795-817`). Les appels sont coalescés par instance, mais pas étalés entre
instances. Des horloges UI à 1 s existent aussi dans `session-list.tsx:117-121`,
`instance-shell2.tsx:375-379` et `instance-tab.tsx:28`; leur coût n'est pas mesuré.

**Plus petite prochaine reproduction :** monter 1/5/20 instances contre clients fake,
compter requêtes et concurrence au tick 30 s, puis mesurer retard RAF et commits Solid
avec zéro puis plusieurs Forms/permissions. Tester visibilité/inactivité séparément.
Ne modifier intervalle, staggering ou demande visible qu'après avoir établi une pente
avec le nombre d'instances.

## Ordre recommandé

1. Rejouer P1 : gain historique majeur et patch déjà borné/qualifié.
2. Rejouer P2 : évite les faux freezes d'état sans toucher au transport.
3. Corriger P3 si le test Fastify confirme le retard concurrent ; le mécanisme bloquant
   est déjà mesuré.
4. Profiler P4 et P5 en parallèle conceptuel, mais ne promouvoir un correctif qu'avec
   une mesure par phase et un fixture de non-régression.

Cette carte ne prétend pas expliquer le freeze de compactage ni le blocage HTTP
Linux/Windows persistant après restart. Elle évite également de compter comme
intégrées les corrections seulement présentes dans `audit/resume-integration`.
