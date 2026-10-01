# #824 — validation combinée fraîche

## Verdict terminal

**Le gate navigateur complet frais n'est pas vert** : 356 pass, 3 fail, 1 skip.
Serveur (après replay), typechecks, builds, assertions stores et fixture native
passent, sur sources inchangées. A/B frais positif. Le replay des trois cas passe
3/3 naturellement ; les huit suites ciblées passent **104/104** naturellement.
Le travail de validation et sa clôture sont **terminés**, pas « tous les gates verts ».
Aucun verdict
« tout vert » ne peut être déduit d'un succès ciblé. Les résultats ci-dessous ont
été exécutés ici, et ne recyclent ni les anciens 348 passes navigateur ni les
mesures des audits précédents.

2026-10-01, worktree `issue-824-performance`, HEAD
`366830f6b4373e6b283cabf7dd04764e87e1cc32`, modifications mission non committées.
Les quatre dépendances de revue sont completed ; la re-review indépendante a clos
M1. Aucun produit/test/config/lock/dependency édité par ce validateur ; seul ce
rapport et les artefacts privés de validation sont sa livraison. Aucun déploiement,
restart utilisateur, commit/push, install ou sous-agent.

## Identité des sources

Artefacts sous :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-combined-b91c8b66fcc840e1909170c5eeb846b9/`.

`initial.json` enregistre **1 696 fichiers** : Git tracked **et** untracked non
ignorés, y compris nouveaux tests/modules/scripts, configs et lockfiles. Parmi eux,
1 379 chemins dans les sources packages, 43 suites browser et 69 scripts. Hash des
octets bruts, pas de normalisation des fins de ligne. Exclusions : Markdown/PDF/docs,
dist/public/node_modules/cache/release/target. Les dépendances installées ne sont
donc pas fingerprintées ni modifiées ; environnement/exécutable Node enregistré.

SHA256 initial :
`16a3d4085dac90c27e892a480ae4c0735eb52782a9add8b0ca6732a640f1a4df`.
Chaque gate publie son manifeste avant/après, son statut, son log et leurs SHA256
dans `<gate>-result.json`. Sur les seize gates/tentatives terminés, **aucune dérive**,
y compris par rapport au
manifeste initial. La comparaison constate l'immutabilité aux bornes ; ce n'est pas
un verrou filesystem interdisant une modification transitoire suivie d'un retour.

## Gates frais terminés

Windows x64, Node `v25.2.1`. Tous les exits ci-dessous sont enregistrés, pas inférés
de l'apparition d'un dernier test vert. Les sous-gates inclus dans une suite complète
ne s'additionnent pas à sa couverture.

| Gate | Résultat | Sortie | Temps |
| --- | --- | --- | --- |
| serveur complet, premier run | 792 pass / 1 fail / 6 skip, 799 tests | naturelle, exit 1 | 27,8 s |
| test Git concerné isolé | 9/9 pass | naturelle, exit 0 | 14,1 s |
| serveur complet, replay | **793 pass / 0 fail / 6 skip**, 799 tests | naturelle, exit 0 | 30,8 s |
| typecheck UI | pass | naturelle, exit 0 | 8,2 s |
| typecheck serveur | pass | naturelle, exit 0 | 4,0 s |
| typecheck Electron | pass | naturelle, exit 0 | 1,2 s |
| build serveur, incluant UI + plugins pruning/automation | pass | naturelle, exit 0 | 26,0 s |
| stores/reducer/admission/pruning | **141/141 pass** | **force-exit**, exit 0 | 7,2 s |
| nouveau test store compactage sans force-exit | 11 assertions affichées pass, pas de résumé final | **timeout 30 s**, SIGTERM privé | non qualifiant lifecycle |
| event-source-handlers | 4/4 pass | naturelle, exit 0 | 0,23 s |
| diff-check tracked | pass, avertissements LF/CRLF seulement | naturelle, exit 0 | 0,04 s |
| fixture native complète, CLI explicite 2.0.21 | pass | naturelle, exit 0 | 63,4 s |
| navigateur complet | **356 pass / 3 fail / 1 skip**, 360 tests | naturelle, exit 1 | 21 min 38 s |
| A/B renderer, trois couples | 30 samples par variante | naturelle, exit 0 | 90,1 s |
| trois échecs navigateur, replay par noms exacts | **3/3 pass** | naturelle, exit 0 | 33,1 s |
| huit suites navigateur ciblées | **104/104 pass**, zéro skip/cancelled | naturelle, exit 0 | 306,4 s |

Le premier échec serveur est conservé intégralement dans `server.log` :
`git-worktree-config.test.ts`, test « checks a redirected main checkout when opened
from an ordinary linked checkout », échoue dans le **afterEach rmSync** ligne 40
sur un répertoire privé avec `EPERM`. Ce n'est pas une assertion Git échouée.
Les mêmes sources passent ensuite le test isolé et le replay complet. La cause du
refus Windows (processus Git/antivirus/autre) n'est pas démontrée ; ne pas effacer ce
run ni revendiquer deux suites complètes vertes.

Les six skips serveur restent les quatre opt-in WSL write (mode 0600, symlink loop,
conflit mode-only, directory-before-rename) et les deux permissions/symlink POSIX.
Ils ne sont pas couverts sur cet hôte. Le gate store emploie la convention existante
`--conditions=browser --test-force-exit`, avec rejets stricts : il qualifie ses
assertions, **pas le nettoyage du processus**. La tentative naturelle du fichier
nouveau n'a pas résolu cette limite connue de revue. Aucun timer arbitrairement
annulé/unrefé, aucun test/produit modifié pour obtenir un exit vert.

Le build réexécute `npm run build --workspace @neuralnomads/codenomad` : clean du
dist généré, Vite UI, copie public, compilation serveur et bundling des deux plugins.
Avertissements non bloquants : imports à la fois statiques/dynamiques, chunks >500 kB
et données Browserslist anciennes. Aucun rebuild/relaunch de l'application installée.

## Qualification native privée fraîche

Commande exacte avec rejets stricts :

```powershell
node --unhandled-rejections=strict scripts/test-session-pruning-native.mjs 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe'
```

Le script vérifie **2.0.21**, lance son propre enfant `serve`, provider, config,
HOME/XDG et DB privés, et se termine naturellement. Il ne découvre/redémarre/arrête
pas le daemon utilisateur. Fixture conservée :
`C:/Users/Admin/AppData/Local/Temp/opencode/opencode/codenomad-pruning-native-BRHy0F`.

`native.log` confirme subscriber abort/return/throw sans invalider la connexion,
relay FIFO/slow recipients/shutdown, worktrees et cache, vraies routes proxy
prompt/command/Shell/inbox/cancel/Forms/permissions, pièce jointe 5 MiB, counts/search,
outline 1 501 messages, cleanup/retry/restore/fork, découverte et présence du plugin
bundlé. C'est **un fixture complet**, pas un nombre de tests à ajouter aux 799.
Le restart mentionné dans son log ne concerne que son enfant jetable.

Cela confirme le bundle et les intégrations sur runtime privé Windows, pas une vraie
charge utilisateur/provider, ni Electron Linux → Windows LAN/OpenCode 2.0.19.
Les deux anciens fixtures complets et la matrice native compaction du coordinateur
restent des preuves historiques distinctes, non additionnées aux résultats ici.

## Navigateur et A/B

Replay complet lancé avec `npm run test:browser --workspace @codenomad/ui`, budget
60 minutes, sans force-exit/force-click. Avant lancement : demande au coordinateur,
journal ancien non trouvé à son chemin exact, puis vérification read-only des
processus Node : aucune suite `tests/browser|test:browser` encore en cours. Aucun
processus partagé arrêté. Ce replay utilise les sources courantes, pas le vieux gate.

Le run complet termine naturellement (exit 1), aucun cancelled, aucun drift. Le
skip reste « Electron BrowserWindow native zoom retains tab seams and matching
scrollbars » : opt-in `CODENOMAD_TEST_ELECTRON` absent (`tab-chrome.test.ts:116`).

Échecs exacts conservés dans `browser.log` :

1. `git-history.test.ts:590`, « central diff inserts local lines and revision-qualified
   history into the real session composer » : assertion ligne 609 `false !== true`
   sur l'identité textarea/`document.activeElement` après clic Ajouter au prompt.
   Les deux assertions de texte/référence précédentes passent ; pas de perte de
   brouillon démontrée par cet échec.
2. `mcp-motion.test.ts:47`, « eight connected MCP servers stay static at rest
   (reduce, 150% scale) » : timeout 30 s sur `window.mcpFixture` avant assertion
   de géométrie/animation. Cause du non-montage non démontrée.
3. `session-rendering.test.ts:82`, « user HTML mode preserves Markdown, pasted
   disclosures and code source and fences legacy caches » : timeout 30 s ligne
   104 sur visibilité `#cache .cached-html` après `fixture.literal(false)`.

Les gates compactage/SSE/HTTP/membership et le sample instrumenté sont verts dans
ce même run, mais une régression session-rendering voisine ne l'est pas. Les scopes
ne s'additionnent pas aux 360 tests. Le replay ciblé n'altère ni code, timing bounds,
clics, exits ou assertions et doit être rapporté séparément.

### Disposition des trois échecs au replay

`browser-failures.log` et `browser-failures-result.json` : 3 tests, 3 pass, zéro
fail/skip/cancelled, rejets stricts, exit 0 naturel en 33,1 s. Manifeste avant/après
identique à l'initial. Filtrage des noms exacts dans les trois mêmes fichiers,
**sans modifier leurs fixtures, délais, clics ou assertions**. Ce constat suffit
pour dire « non reproduits dans ce replay », pas « résolus » ni « causes connues ».

| Échec complet | Démontré | Pas démontré / prochain élément minimal |
| --- | --- | --- |
| insertion Git, focus | contenu et référence insérés ; focus non revenu au textarea à l'instant de l'assertion ; replay pass | Ordre/timing exact de focus non capturé. En cas de récurrence, enregistrer activeElement et les callbacks de restitution de focus autour du clic, sans changer l'assertion. |
| MCP readiness | `window.mcpFixture` absent après 30 s dans le complet ; replay pass | Cause d'échec de bootstrap non capturée. Capturer pageerror/console/requestfailed et réponses modules Vite au montage, avant d'attribuer au cache ou au produit. |
| user HTML/cache | `#cache .cached-html` pas visible après passage literal(false) ; replay pass | DOM/cache/promise de rendu à cette frontière non capturés. Capturer DOM, état literal et résolution du rendu avant/après toggle au prochain échec. |

Scheduling/charge de l'hôte, optimisation Vite ou état de cache sont des pistes,
pas des causes démontrées. Aucun patch proposé pour fabriquer un gate vert. Une
nouvelle suite complète éventuelle relève de la décision du coordinateur après
attribution ; le suivi de clôture ne lance aucune suite supplémentaire.

### Suites ciblées existantes récupérées à la clôture

Le runner déjà lancé `validate.cjs browser-failures focused` (shell
`sh_0f93a730b001Ofu9KyF5KkL76a`, PID 41540 lors du contrôle) est terminé ; son
résultat final a été reçu, pas inféré du dernier test affiché. Aucun nouveau run
de validation ou audit n'a été lancé lors de `validation-closeout`.

`focused-result.json` : exit 0 naturel, rejets stricts, 306,4 s, sources avant/après
et par rapport à l'initial inchangées. `focused.log` : **104 tests, 104 pass, 0 fail,
0 skip, 0 cancelled**. Détail non additif : compactage 5, isolation SSE 5, HTTP/1
admission 5, render-cost 13, history-navigation 21, session-rendering 46, task-copy 6,
tool-images 3. Le cas user HTML passe donc aussi dans sa suite voisine complète,
pas seulement sous le filtre des trois retries. Sample 80 shells sans remount et
compteurs/contenus compactage exacts restent vérifiés. Ni ce gate, ni les trois
retries ne changent le statut du fullbrowser à exit 1.

## Pièces terminales et décision suivante

`terminal-gates.json` indexe les seize statuts, commandes exactes, heures, sorties
naturelles/forcées, SHA256 des logs/manifests et dérives. Le runner privé final est
conservé sous `validate.cjs`, SHA256
`66d119cfe89bd824e3568e5a0447106e06fc5633c2cb0456a86515d9caecb064`.

Principaux logs SHA256, dans le répertoire d'artefacts ci-dessus :

| Fichier | SHA256 |
| --- | --- |
| `browser.log` | `19099de5e3c3ec694334c4667575715d8dc2dc906f80e558cf54773ea0880a1b` |
| `browser-failures.log` | `6035e5c53b01dc30cc936d6183d8625ebda890908c5ffe7b24d63e9c8010f130` |
| `focused.log` | `bac7cadaf82a5cbf238851a1f5f86eac1b6b431352c0dc5e3161e9db75752628` |
| `server.log` (premier échec) | `d8660dcba0935f9a94fdb965eb9a7723a0f9d8000db18e6ea79bbcce96c55247` |
| `server-rerun.log` | `8fafb4e813b85cfd8abc74bd7e1e1f6f4b4a9df38bb4a6f7934d9781923f84de` |
| `native.log` | `e74886aee42300ee4543a6f2518bc8b714aeec4922f428f4f8ea113efa994ee7` |
| `ab.log` | `0d2e7cb864ff89060d552a4aafa3ed0d1da7f1ba2ca17c7fa7068b1d32be9205` |

Le suivi propriétaire a récupéré ces artefacts, finalisé seulement ce rapport et
son index privé, sans edit produit/tests/config/deps, installation, merge, commit,
push, suppression de sessions, restart ou déploiement. Les travaux de validation
peuvent être rapportés `completed` ; **la qualification globale reste non verte**.
Le coordinateur décide de la clôture de mission, pas ce validateur.

Prochain minimum utile : conserver les trois preuves d'échec global et les retries
séparés ; si un fullbrowser vert est un critère de livraison, autoriser un suivi
instrumenté des trois frontières décrites plus haut, puis décider d'un nouveau
gate complet figé. Ne pas élargir les corrections #824 sur simple hypothèse de
flake. La sortie naturelle stores et Linux Electron → Windows LAN/2.0.19 demeurent
des limites explicites, pas des gates implicitement acquis.

### A/B CPU du postimage M1 actuel

`node scripts/test-render-cost-audit.mjs 3` passe après le fullbrowser : trois
couples alternés baseline/fixed, 80 outils × 8 000 caractères, trois warmups puis
dix deltas chacun, **instrumentation off**. SHA produit testé
`f07ce171a6b1d3394ce94be496b0abd67f8bc0bb48e946eb9173a681c844f401`.
Baseline `47f9e43e` a le même blob renderer que `366830f6` (preuve précédente).

| ms/delta, médiane [min–max], écart-type échantillon | Baseline | Postimage courant |
| --- | --- | --- |
| main-thread TaskDuration | 324,57 [168,06–743,53], 173,67 | 16,94 [9,93–50,33], 11,27 |
| ScriptDuration | 14,51 [7,88–46,20], 9,03 | 0,25 [0,11–32,37], 9,34 |
| dispatcher sync | 12,05 [6,70–19,90], 3,70 | 0,20 [0,10–0,50], 0,08 |
| layout | 2,88 [1,51–4,27], 0,55 | 0,08 [0,07–0,23], 0,04 |
| recalcul style | 10,20 [5,74–13,91], 1,82 | 0,13 [0,10–0,30], 0,05 |

30 échantillons par variante. CDP cumule jusqu'à deux animation frames ; ce n'est
pas une mesure de latence-frame, FPS, heap, débit ou Electron production. Host
activity non contrôlée ; pas de seuil absolu CI. Ces chiffres sont nouveaux et
séparés des A/B antérieurs au correctif membership. Le fullbrowser instrumenté
indépendant compte **80 clones / 0 added / 0 removed** dans chacun de dix deltas,
avec assertion anti-remount ; les valeurs zéro du run instrumentation off ne sont
pas des compteurs de travail réel.

Artefact A/B :
`C:/Users/Admin/AppData/Local/Temp/opencode/codenomad-render-cost-srSQOf/metrics.json`,
SHA256 `c72a491eba14d5e71178ba2895a7304ce07f98a02d340a53ef9f75f4424b7cd0`,
six logs bruts adjacents. `generated-and-ab-hashes.json` identifie aussi les deux
plugins bundlés utilisés par la reprise native.

## Limites et tailles signalées

- Pas de qualification Electron Linux, LAN/VPN ou runtime 2.0.19, ni preuve
  d'élimination universelle du freeze signalé. Le test HTTP/1 Chromium est Windows
  loopback ; native et browser constituent des périmètres distincts.
- Buffer compactage sans plafond explicite octets/événements dans une tâche sans
  yield ; le délai 250 ms n'est pas une garantie de mémoire bornée.
- Scan task structurel à chaque révision conserve les bornes 10 000/200 mais peut
  coûter du CPU même sans changement de membership. Le sample 80 est borné, pas
  une mesure du pire cas ni de heap/FPS/production desktop.
- Un pas SQLite reste synchrone malgré le budget coopératif du scanner outline.
- Le hashing async utilise toujours le pool libuv et le CPU/mémoire disponibles.

Surfaces modifiées par la mission au-dessus du seuil de signalement (~500 lignes),
sans refactor de taille par cette validation :

- `packages/server/src/server/http-server.ts` ~2 346 lignes ;
- `packages/server/src/workspaces/manager.ts` ~1 240 ;
- `packages/ui/src/stores/instances.ts` ~2 093 ;
- `packages/ui/src/stores/opencode-data.ts` ~828 ;
- `packages/ui/src/components/tool-call/renderers/task.tsx` ~569.
