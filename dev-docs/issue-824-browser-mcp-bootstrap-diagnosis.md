# #824 — diagnostic borné du bootstrap MCP navigateur

## Verdict

**Timeout de readiness reproduit une fois sur cinq ; cause non attribuée.**
Quatre reprises passent et une échoue avant les assertions MCP, avec le même
`page.waitForFunction(window.mcpFixture)` à 30 s que le fullbrowser antérieur.
Les cinq processus sortent naturellement ; pas de skip/force-exit/force-click.
Le suivi est terminé dans son budget, mais n'accepte ni la mission ni le gate
fullbrowser, qui conserve ses 356 pass / 3 fail / 1 skip.

La capture a une faiblesse explicite : son plafond commun de 4 000 observations
est saturé par les requêtes de modules **avant les diagnostics terminaux**. Elle
ne permet pas d'exclure une erreur/rejection tardive ni de dire si le module est
bloqué avant son corps, dans `applyUiSettings` ou dans `render`. Aucun défaut
produit confirmé, aucun correctif produit ou harness proposé comme déjà validé.

## Périmètre et méthode

2026-10-01, Windows x64, Node `v25.2.1`, Chromium `153.0.8010.12`, worktree
`D:/CodeNomad/.codenomad/worktrees/issue-824-performance`, HEAD `366830f6`.
`combined-validation` et `validation-closeout` sont déjà rapportées terminées.

**Aucun fichier produit, test ou fixture source édité.** Seul ce rapport est créé
dans le dépôt. Aucun audit ou fullbrowser supplémentaire, aucune dépendance/config/
lock modifiée, installation, commit/push/merge, restart/déploiement, suppression de
sessions, accès au daemon/base/profil utilisateur ou sous-agent.

Artefacts privés :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-mcp-bootstrap-4770677d4da549e98e255c79c7ecdba3/`.

Le script `diagnose.cjs` copie le texte exact de `mcp-motion.test.ts` en privé,
préserve assertions, timeouts, clics et options Chromium/Vite, puis compile cette
copie TypeScript avec l'esbuild déjà installé. Seuls les imports Node des packages
et la racine Vite sont rendus absolus, puisqu'elle n'est plus dans le dossier du
test original. Vite sert toujours les vrais modules/stylesheet et la fixture source.

Observations ajoutées en mémoire dans cette copie, sans catch qui transforme un
échec en succès ni `preventDefault` d'erreur :

- console, pageerror, request/requestfinished/requestfailed ;
- statut, headers/content-type, URL et type des réponses des modules Vite ;
- erreurs et unhandledrejection dans un init-script de page ;
- marqueurs privés par transform Vite : entrée du corps de fixture, avant/après
  settings, avant render et après publication de `mcpFixture` ;
- tentative de snapshot terminal dans le finally, puis fermeture originale.

Le cache Vite conserve son emplacement/options ordinaires (`node_modules/.vite`),
pas une nouvelle politique de cache. Le plugin d'observation privé et l'observer
peuvent toutefois influencer timing et clé d'optimisation : ceci n'est **pas** un
A/B causal contrôlé du cache ou du coût de bootstrap. Aucune suite complète
concurrente repérée lors du contrôle read-only préalable ; les ciblés indépendants
du reviewer ne constituent pas une charge de l'hôte maîtrisée.

## Résultats exécutés — cinq reprises, pas davantage

Filtre exact :
`^eight connected MCP servers stay static at rest \(reduce, 150% scale\)$`.
Chaque processus exécute un seul cas avec rejets stricts et concurrence 1. Le
budget total du runner est **84,7 s**, sous dix minutes ; aucune relance après
ces cinq reprises et aucune assertion/durée artificiellement assouplie.

| Reprise | Résultat du cas | Exit | Naturelle | Processus, durée observée |
| --- | --- | --- | --- | --- |
| 1 | pass | 0 | oui | 11,25 s |
| 2 | **fail readiness 30 s** | 1 | oui | 41,03 s |
| 3 | pass | 0 | oui | 12,00 s |
| 4 | pass | 0 | oui | 9,63 s |
| 5 | pass | 0 | oui | 9,46 s |

Le runner global sort exit 1 car une reprise échoue : il ne masque pas le rouge.
Ces cinq exécutions d'un même scénario ne sont pas cinq scénarios de couverture
nouveaux et ne remplacent pas le gate complet antérieur.

## Ce que la capture démontre / ne démontre pas

Dans la reprise rouge :

- Le document `/mcp-motion` et `/tests/browser/fixtures/mcp-motion.tsx` répondent
  **200**, respectivement HTML et JavaScript. Le serveur a appliqué la transform.
  Une absence totale de réponse de ces deux entrées n'explique donc pas ce run.
- Le préfixe enregistré comprend **1 645 requêtes**, **1 175 réponses 200** et
  **1 175 requestfinished**. Les modules optimisés Solid/debug répondent aussi 200.
  De nombreux modules sont des icônes `lucide-solid/dist/source/icons/*.jsx`,
  conformément à `optimizeDeps.exclude: ['lucide-solid']` existant.
- Les seuls messages console retenus sont `[vite] connecting...` et `connected.`.
  Aucun pageerror, requestfailed ou statut >=400 n'apparaît **dans ce préfixe**.
  Ceci ne prouve pas leur absence dans la totalité du run.
- Le plafond de 4 000 événements est atteint vers 10,14 s après début du processus
  de test. Il est aussi atteint dans les quatre passes (8,42–10,93 s), donc sa
  saturation n'est ni un discriminateur du timeout ni une cause de freeze établie.
- Le log Node démontre le timeout après `goto`, sur la readiness, pas une assertion
  « huit serveurs ready », ni une animation perpétuelle du composant.

**Limite de capture confirmée** : les snapshots/stages, événements ready et erreurs
tardives partagent le même plafond avec le réseau. Ils ont été perdus, y compris
le snapshot terminal qui aurait permis de localiser la frontière. Ne pas convertir
cette absence d'observations en absence d'erreur produit. La quantité de modules,
une collision/rebuild du cache Vite, l'ordonnancement, la charge de l'hôte ou une
attente settings/render restent des hypothèses, pas des causes démontrées.

Le fixture source substitue l'inventaire Shell et le client MCP ; aucune compaction
native ou connexion à un vrai MCP/OpenCode n'est testée ici. Rien dans ces traces
n'attribue le freeze original #824 à MCP ni à Electron Linux → Windows.

## Empreintes et artefacts

Avant/après chaque reprise : **1 696 fichiers** tracked + untracked non ignorés,
sources/tests/scripts/configs/lock inclus, hors docs/générés/dist/public/deps/cache.
Pas de dérive et mêmes hashes de fichiers que la validation combinée. Le format
du manifeste privé (map path->SHA seulement) diffère du manifeste combiné enrichi.
`results.json` confirme `originalTestUnchanged: true`, `fixtureUnchanged: true`.

- `initial.json`, `<n>-before.json`, `<n>-after.json`, `<n>-result.json` : empreintes
  et statuts. SHA initial `c4c4ff2bbc0c022b27258bda2ba085f79062f0cb982341b3ced09d0cd07adaa9`.
- `test-original.ts`, `fixture-original.tsx`, `test-observed.ts` et
  `test-observed.mjs`, plus `harness.json` : provenance et modifications privées.
- `<n>.log`, `<n>-trace.json` : logs/traces complets **jusqu'au plafond**, pas traces
  complètes de la vie de page. `trace-summary.json` identifie la saturation.
- `2-module-prefix.json` : réponses d'entrée et modules optimisés du rouge.
- `2.log` SHA256 `0830b1ee6d0b74c4640c434529227ce61193fcfe8ca01f41251bef114e264284`.
- `2-trace.json` SHA256 `d414677c96cb7ab5b4e2a79b18eff64fa6bf07539e5e205333c94725157e4332`.
- `diagnose.cjs` SHA256 `a6f4d4702d13624cf8c1123819ec0877da83b8381a07addbd7436fa84f195c1b`.

## Prochain minimum utile — décision du coordinateur, pas une relance ici

Autoriser un nouveau suivi **seulement si l'attribution reste nécessaire** : séparer
les événements critiques dans une réserve indépendante du réseau, conserver toujours
un snapshot terminal/stages/rejections, et agréger les réponses modules par URL/status
plutôt que laisser leur volume éjecter le diagnostic. Avec ce harness corrigé, capturer
une nouvelle occurrence avant toute décision de patch ou expérience causal-cache.
Ne pas changer les assertions, les 30 s, les gestes ni la politique produit pour
obtenir artificiellement du vert. Aucun patch produit minimal ne peut être recommandé
sur les preuves actuellement disponibles.
