# #824 — récupération du correctif de rendu des tâches imbriquées

2026-10-01, worktree `issue-824-performance`, HEAD `366830f6`.

## Résultat et portée

Le correctif minimal de `task.tsx` est maintenant présent dans le worktree mission,
sans commit/push ni déploiement. Deux régressions rouges sont reproduites sur la
source baseline ; la correction passe les **63 scénarios** des quatre suites
navigateur ciblées, naturellement, sans force-exit, skip ou force-click ajouté.

La mesure A/B finale, 30 échantillons par variante, observe une médiane de temps
main-thread **353,39 -> 22,72 ms** par delta dans le fixture, pas dans l'application
desktop. Le contrôle instrumenté confirme **80 retraits + 80 insertions -> zéro**,
avec **80 snapshots conservés**. Ce patch n'élimine pas les relectures natives.

Seuls ces six fichiers appartiennent à cette tâche :

| Fichier | Delta / taille |
| --- | --- |
| `packages/ui/src/components/tool-call/renderers/task.tsx` | +29/-18, 647 lignes |
| `packages/ui/tests/browser/render-cost.test.ts` | nouveau, 245 lignes |
| `packages/ui/tests/browser/fixtures/render-cost.tsx` | nouveau, 150 lignes |
| `packages/ui/tests/browser/fixtures/render-cost-timeline.tsx` | nouveau, 44 lignes |
| `scripts/test-render-cost-audit.mjs` | nouveau, 57 lignes |
| `dev-docs/issue-824-render-recovery.md` | ce rapport |

Aucun changement de cette tâche dans les stores, `server-events`, `opencode-service`,
styles, dépendances ou serveur. Les modifications concurrentes de ces surfaces dans
le worktree commun ne sont pas notre livraison. Aucun daemon partagé, profil,
desktop, réseau utilisateur ou base utilisateur utilisé ; aucune dépendance
réinstallée/symlinkée. Les HTTP fixtures sont loopback et bloquent les autres origines.

## Provenance et logique

Source : `audit-resume-integration`, correction du précédent audit de rendu.
Le blob baseline de `task.tsx` est identique à `47f9e43e` et `366830f6` :
`dee90df8560b83958dbf6d6f7c40e013bbdb289f`.
Le postimage produit canonique Git est identique au correctif audit :
`9a427900afcad8f274db5d9a77600836f24a728e`.
Les SHA bruts diffèrent pour ce seul fichier à cause des fins de ligne du checkout ;
comparaison LF-normalisée et `git diff --no-index` : aucun delta de contenu.

Les deux fixtures et le runner A/B sont repris byte-for-byte de l'audit. Le test
était aussi identique avant une adaptation de harness : chaque serveur utilise
désormais un cache Vite temporaire unique, supprimé après fermeture. Cela sépare
ses modules optimisés des autres fixtures concurrents, sans changer les assertions.

La correction conserve les clés affichées pendant une relecture autoritaire,
réindexe dès son retour, et maintient une shell par identité de tool avec getters
réactifs. Un changement de clé remonte bien une shell neuve. Une page autoritaire
vide supprime les étapes ; une erreur de lecture conserve le dernier affichage et
le retry explicite. Markdown utilise son hash existant plutôt qu'une révision
normalisée à zéro ; la révision de part reste suivie pour les updates in-place.

## Reproductions fonctionnelles exécutées ici

Node `v25.2.1`, Windows, Chromium Playwright `153.0.8010.12`, Vite development.

Contrôle rouge par override Vite de la source exacte baseline, sans réécrire le
renderer du checkout : deux assertions échouent avec messages attendus, pas timeout :

1. `authoritative reprojection must not recreate the tool shell` ;
2. `the native record changed but the displayed Markdown is stale`.

Le sample instrumenté baseline passe son contrôle de 80 étapes et compte 80 ajouts,
80 retraits et 80 clones à chacun des dix deltas. La commande rouge a donc un exit 1
attendu (2 FAIL + 1 PASS) ; le wrapper de collecte garde cet exit dans le log.

La suite verte finale passe **63/63**, zéro skip/failure, exit 0 naturel (~202 s) :
render-cost (8), session-rendering (46), task-copy (6), tool-images (3). Elle exerce
les vrais composants Solid, stores et dispatcher SSE, avec seulement le transport
natif et les réponses API synthétiques. Le maintien du scroller pendant MMB, du
scrollTop et disclosure, les copies exactes, l'update in-place, l'erreur/retry,
la suppression et le changement de clé sont réellement vérifiés.

`npm run typecheck --workspace @codenomad/ui` passe, y compris au dernier replay.
`git diff --check` des fichiers de livraison passe.
Le test est admis par le glob existant `tests/browser/*.test.ts` du script package ;
aucune modification de gate/manifest n'est nécessaire.

## A/B CPU actuel — séparé des résultats historiques

Protocole inchangé : 80 étapes read terminées × 8 000 caractères, collapsed ;
3 warmup deltas puis 10 deltas isolés dans chacun des trois couples baseline/fixed.
Processus/pages frais, alternance baseline puis fixed ; compteur clone et observer
DOM **désactivés** pour les timings. CDP cumule les durées jusqu'après hydration et
deux animation frames. Les coûts sync seuls n'incluent pas le travail différé.

| ms/delta, médiane [min–max], écart-type échantillon | Baseline | Correction |
| --- | --- | --- |
| main-thread tasks | 353,39 [189,76–737,96], 141,77 | 22,72 [11,00–68,03], 12,39 |
| script | 18,65 [14,75–57,85], 11,10 | 0,92 [0,29–40,30], 10,04 |
| layout | 3,58 [2,93–5,39], 0,63 | 0,14 [0,09–0,36], 0,05 |
| recalcul style | 11,69 [10,39–14,35], 0,94 | 0,20 [0,11–0,32], 0,06 |
| dispatcher sync | 17,25 [11,20–33,60], 4,88 | 0,25 [0,10–0,50], 0,11 |

L'audit antérieur rapportait 369,98 -> 20,64 ms sur 30 échantillons par variante.
Ce ne sont pas les échantillons actuels et ils ne sont pas fusionnés avec eux.
Le premier A/B actuel était 353,90 -> 17,03 ms ; le replay suivant 378,59 -> 15,61 ms.
Ces variations ne sont pas une garantie de latence/FPS et aucun seuil CI absolu
n'est ajouté.

## Tentatives et limites conservées

Deux reprises A/B supplémentaires ont échoué avant le montage du fixture fixed,
sur `page.waitForFunction(window.fixture)` après 30 s. Elles restent dans
`codenomad-render-cost-lehbGS/3-fixed.log` et `codenomad-render-cost-FN0wKE/1-fixed.log`
sous le temp approuvé. Pas de gain CPU calculé depuis ces lots incomplets.
Leurs erreurs sont de démarrage du harness, pas une assertion renderer. La
collision du cache Vite partagé est une **hypothèse**, pas une cause démontrée :
après isolation du cache, les six invocations A/B et 63 tests passent, mais il n'y
a pas eu de contrôle négatif causal du cache en concurrence.

Des snapshots SHA avant/après des sources ont aussi détecté des mutations de tâches
concurrentes (stores compaction, event handlers, serveur et ressources générées).
Les cinq fichiers exécutables de notre livraison sont restés inchangés pendant
le dernier A/B + suite verte. Ces runs **ne sont pas une qualification d'une
composition intégrée entièrement immuable** : refaire le replay indépendant sur
une composition figée après intégration des autres correctifs. Les wrappers
marquent cette dérive par un exit 1, distinct des enfants A/B et tests, tous exit 0.

Pas de qualification production-build, Electron/WebView2, Linux/macOS, heap,
GPU/FPS, backend réel, compactage natif ou freeze applicatif universel. Le coût des
clones/relectures demeure. `task.tsx` reste **647 lignes**, au-dessus du seuil de
signalement ~500 ; aucun refactor de taille seul n'a été introduit.

## Artefacts et commandes

Tous les chemins ci-dessous sont sous
`C:/Users/Admin/AppData/Local/Temp/opencode/` :

- `issue-824-render-isolated-xn3MnK/red-final.log`
  SHA256 `947bb2f6beae52db032288e8f855af27fcaa7deb90a3787a85fdf49f82a06c18`.
- `issue-824-render-isolated-xn3MnK/green.log`
  SHA256 `15b7d31be5b99cbc8e3bf62f322fa5b14a1f710e740a5cd0b2a8e0d4c718a7bd`.
- `issue-824-render-isolated-xn3MnK/{before,after,result}.json` : dérive de composition.
- `codenomad-render-cost-dD0phn/metrics.json` et six logs adjacents : A/B final.
  SHA256 metrics `f1a2a4a7ce5ca6f042328bc5d8e84fc315be49c90a5f26a67759859d3e801ba8`.

SHA256 produit brut livré : `task.tsx` =
`d130c5fb2219772c5de0c63393744783cdb659734024f88cbe73cafeec818100`.
SHA256 test final = `4abe4345a3a5f1a00d0e94544fd02b70851d07efa6b294a55466bc51ef7d2fde`.

```powershell
$env:TEMP='C:\Users\Admin\AppData\Local\Temp\opencode'
$env:TMP=$env:TEMP
# Dans packages/ui, override baseline pour les assertions rouges uniquement :
$env:CODENOMAD_RENDER_TASK_BASELINE='<temp>/task-baseline.tsx'
node --import tsx --test --test-concurrency=1 --test-name-pattern='^(unrelated child text|native page output|audit sample:)' tests/browser/render-cost.test.ts
Remove-Item Env:CODENOMAD_RENDER_TASK_BASELINE
node --import tsx --test --test-concurrency=1 tests/browser/render-cost.test.ts tests/browser/session-rendering.test.ts tests/browser/task-copy.test.ts tests/browser/tool-images.test.ts
# À la racine :
node scripts/test-render-cost-audit.mjs 3
npm run typecheck --workspace @codenomad/ui
```

Prochaine étape minimale : revue indépendante des six fichiers de cette livraison,
puis replay des deux assertions rouges, 63 contrôles verts et A/B sur une composition
figée. Aucun restart/déploiement ni élargissement du patch n'est nécessaire.
