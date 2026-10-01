# #824 — capture critique du bootstrap MCP

## Verdict terminal

**5/5 reprises ciblées passent naturellement, timeout non reproduit.** La faiblesse
du collecteur est corrigée et vérifiée, et les cinq traces critiques sont complètes
jusqu'à fermeture, sans aucun overflow. L'attribution du timeout historique reste
ouverte : aucune nouvelle occurrence rouge n'a permis d'en localiser la frontière.
Travail de capture terminé, pas preuve d'élimination de panne ni gate global vert.
Le fullbrowser historique reste 356 pass / 3 fail / 1 skip ; le rouge MCP précédent
1/5 reste conservé, distinct de ce suivi. Aucune sixième reprise n'est lancée.

## Périmètre

Suivi borné de `browser-mcp-bootstrap-diagnosis`, pas une nouvelle validation
complète. Les dépendances `browser-mcp-bootstrap-diagnosis` et
`browser-focus-test-sync` sont terminales `completed`, sans exécution restante,
avant le lancement. Rapport focus-sync lu : ses deux ciblés sont finis, focus
2/2, mais timeout cache HTML indépendant au second run. Ses trois modifications
de tests/fixture font désormais partie de la nouvelle identité à fingerprinter.

Sources exclusivement :
`D:/CodeNomad/.codenomad/worktrees/issue-824-performance`.

Artefacts exclusivement privés :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-mcp-critical-20261001/`.
Le diagnostic précédent reste intact dans `issue-824-mcp-bootstrap-4770677d4da549e98e255c79c7ecdba3`.

Aucune édition produit/test/fixture/deps/config/lock ni politique de cache modifiée.
Seul ce rapport est créé dans le dépôt. Aucun install, commit/push/merge, restart,
déploiement, suppression de sessions, accès au daemon/base/profil utilisateur ou
sous-agent. Contrôle read-only des processus Node avant lancement : aucun ciblé
browser, runner de validation ou fullbrowser concurrent repéré.

## Seule modification expérimentale : le collecteur privé

Le harness précédent est recopié sans altérer ses imports/racine absolus,
assertions, délais 30 s, gestes, options Vite/Chromium ou marqueurs privés de
fixture. Il sert toujours les vrais modules et styles depuis le worktree.

Le réseau est désormais agrégé par événement/URL/status/type, avec compteur,
première/dernière heure et content-type pour les réponses. Plafond de 8 000 clés
distinctes, compteurs totaux et overflow réseau explicites. Pas de body HTTP lu
ni de modification de chargement ou optimisation lucide.

Réserves indépendantes : erreurs 512, lifecycle/ready 256 et consoles 256. Chaque
réserve compte son propre overflow. Les réponses >=400 sont aussi classées comme
erreurs ; les requestfailed/pageerror/test-error ne dépendent pas du plafond réseau.
Le snapshot terminal a son propre emplacement hors de tous ces plafonds, y compris
un résultat `observation-error` explicite si son évaluation ne réussit pas.
Les erreurs/rejections de page disposent d'un buffer 512 et d'un overflow explicite,
indépendants du réseau ; les cinq marqueurs de fixture restent conservés.

Le finally capture le snapshot avant fermeture, sans absorber l'échec du test.
Les observations peuvent influencer le timing : ce n'est pas un A/B causal du
cache, de l'ordonnancement ou du coût d'import. L'emplacement et les options du
cache Vite ordinaires sont conservés, pas nettoyés ou isolés artificiellement.

## Préflight sans navigateur

`collector-selftest.cjs` passe naturellement : 10 001 réponses synthétiques sur
un plafond réseau de deux entrées provoquent 9 999 overflows. Malgré cela,
pageerror, réponse 504, ready-before et snapshot terminal restent présents dans
leurs réserves ; l'overflow erreur indépendant est également vérifié.
`collector-selftest-result.json` conserve les résultats. Syntaxe du runner vérifiée.

## Budget et qualification

Filtre unique inchangé :
`^eight connected MCP servers stay static at rest \(reduce, 150% scale\)$`.
Rejets stricts, concurrence 1, au plus cinq runs / dix minutes, arrêt automatique
sur la première occurrence rouge avec snapshot/stages critiques sans overflow.
Pas de force-exit, skip, force-click ou assouplissement des assertions.

Le runner fingerprint avant/après les sources produit, tests, scripts, configs et
locks tracked + untracked non ignorés, hors docs/générés/deps/caches. Il conserve
les statuts exacts, heures, logs, traces et leurs SHA256 ; une dérive n'est jamais
présentée comme un gate immutable. Son texte, collecteur, copie observée et code
compilé ont leurs propres hashes dans `harness.json`.

## Résultats frais et localisation observée

Runner `sh_0f9561ee5001s5HSuUnJ0dLtTb` terminé, exit 0 naturel ; notification finale
reçue. Windows x64, Node v25.2.1, Chromium 153.0.8010.12. Cinq processus, un cas
chacun, zéro fail/skip/cancelled. Budget total 54,35 s ; pas d'arrêt sur rouge car
aucun rouge dans ce suivi. Ce ne sont pas cinq nouveaux scénarios de couverture.

| Reprise | Exit naturel | Durée processus | Entrée corps fixture, horloge page | Settings | Render → publication |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | 12,04 s | 10,323 s | 29,4 ms | 46,0 ms |
| 2 | 0 | 10,20 s | 8,619 s | 32,0 ms | 43,5 ms |
| 3 | 0 | 10,42 s | 8,819 s | 26,2 ms | 41,8 ms |
| 4 | 0 | 10,11 s | 8,637 s | 30,3 ms | 45,0 ms |
| 5 | 0 | 10,40 s | 8,880 s | 29,1 ms | 44,9 ms |

Dans les cinq passes : `fixture-body → settings-before → settings-after →
render-before → fixture-published`, puis `ready-after` observé. Snapshot final
`mcpFixture: true`, document complete, huit ready dots, 66 caractères au root.
La lecture ready prend 87,3–97,7 ms après son lancement ; `goto(domcontentloaded)`
dure 8,625–10,329 s sur l'horloge Node. Ne pas soustraire les horloges Node/page.

**Localisation du coût dans les passes**, pas de la panne : l'essentiel du temps
de navigation observé précède l'entrée du corps de fixture. Cette région comprend
fetch/transform/parse et évaluation des dépendances/imports, éventuellement leurs
attentes ; les traces ne répartissent pas ce coût. Settings et render arrivent
ensuite et achèvent en quelques dizaines de millisecondes. Cela ne prouve pas
que le timeout rouge antérieur bloquait dans cette même région plutôt que dans
settings/render/ready. Aucun profil CPU ni expérience causal-cache exécuté.

Chaque run conserve **1 837 requêtes, 1 837 réponses toutes 200, 1 837 finished**, soit
5 511 clés événement/URL/status/type, au-delà du vieux plafond commun 4 000 sans
perdre le snapshot. Zéro requestfailed, pageerror, test-error, erreur/rejection dans
les stages ; overflow réseau/erreurs/lifecycle/console/stages tous zéro. Ceci porte
sur ces cinq runs jusqu'au finally, pas sur l'ancien rouge ni sur une vie de page
illimitée après fermeture.

Les consoles **ne sont pas exemptes d'erreurs** : un message EventSource MIME
`application/json` au lieu de `text/event-stream` apparaît dans chaque passe,
avec quatorze warnings Solid « computations created outside a createRoot or render »
et deux messages Vite debug. Le MIME est cohérent avec la route fixture existante
qui remplace toutes les requêtes `/api/**` par `{}` JSON. Sa présence dans les cinq
passes ne démontre ni sa causalité dans le timeout ni son innocuité universelle.
Ces consoles et leurs emplacements sont conservés intégralement ; aucun filtre
pour fabriquer du vert.

## Identité fraîche et pièces terminales

Les **1 696 fichiers** ont les mêmes hashes à l'initial, avant/après chaque run et
au terminal ; zéro drift, y compris entre runs. Le SHA256 des manifests privés
`initial.json` et `terminal-manifest.json` est
`4628acfc4df16f8e573da48dab23df3614a7a8a55643466e5e6e8e4f6e80105b`.
Les seuls écarts avec le diagnostic précédent sont les trois fichiers attendus
de focus-sync (`git-history.test.ts`, `session-rendering.test.ts`, `user-html.tsx`).
Ils ne sont pas édités par ce suivi ; les anciens manifests restent historiques.

`harness.json` et `terminal-receipt.json` vérifient les SHA256 exécutés inchangés :

| Input privé | SHA256 |
| --- | --- |
| `diagnose.cjs` | `4ffab45b45c46e5d09e6d8f0e2b2259fe04cdfb41a02689826119fbba9b583bc` |
| `collector.cjs` | `914cfc1b5b8ab02a98b20157a5c1706056f6ab928b37f0f32bee03a8fe4d08b0` |
| `test-observed.ts` | `a76ae27a9fa8ed04c1f0536ab58b809208fda7edb90c7b27b9fff012db0f30da` |
| `test-observed.mjs` | `cce160f88fbba195c702e3134bc5a1a638936054dbe8148fe6c774357b380ca1` |

Test source original SHA256
`5820fe789d7470a5c6607998fbf7d068ed25df61611e496e4eec9968537669ec`,
fixture original SHA256
`f883fa1acd7318b10c5a517e4b1da0983fde384d2581e0046c7232312e299824`.
Les copies originales et leurs fichiers source sont inchangés.

`<n>.log`, `<n>-trace.json`, `<n>-result.json` conservent chacun leur hash vérifié ;
`results.json`, `trace-summary.json` et `terminal-receipt.json` indexent les cinq
runs, phases, réserves/overflows et sorties. `collector-selftest-result.json`
conserve le préflight. Aucun artefact antérieur n'est écrasé.

## Décision minimale suivante

**Pas de nouvelle boucle de diagnostic ni patch produit justifié ici.** Le
coordinateur peut utiliser ces traces complètes et le harness privé exact comme
capture MCP du gate unique s'il l'autorise. Sans occurrence rouge instrumentée,
l'attribution reste explicitement non qualifiée ; si elle est un critère obligatoire
de livraison, c'est un blocage honnête de ce critère, pas un succès déduit des retries.
Ni imports/lucide, cache Vite, charge hôte, settings ou render n'est une cause prouvée.
Conserver séparément cache HTML ouvert, Linux Electron → Windows LAN/2.0.19 et
sortie naturelle stores non qualifiés. La clôture de mission appartient au coordinateur.
