# #824 — gate navigateur final unique

## Verdict terminal

**Gate non vert : 360 tests, 358 pass, 1 fail, 1 skip, 0 cancelled.**
Commande normative exécutée **une seule fois**, exit 1 **naturel**, sans timeout ni
force-exit. Zéro dérive des sources. Travail de validation terminé et rapporté,
pas acceptation globale. Aucun retry/ciblé ou second fullbrowser après ce rouge.

L'échec unique est `git-history.test.ts:684`, sur le contrôle final `errors=[]` :
un pageerror `ReferenceError: __name is not defined` vient d'un script navigateur
anonyme. Ce n'est **pas** l'ancien échec d'identité du focus ni le clic Monaco.
Le snapshot opt-in est présent mais sa chronologie est vide. Le cache HTML et le
cas MCP précédemment rouges passent ici, sans démontrer leur résolution causale.
Le gate historique 356/3/1 et les diagnostics ciblés restent des pièces séparées.

## Admission fraîche

Workdir exact : `D:/CodeNomad/.codenomad/worktrees/issue-824-performance`.
HEAD `366830f6b4373e6b283cabf7dd04764e87e1cc32`, changements mission non committés.
Rapports `issue-824-browser-focus-test-sync.md` et
`issue-824-browser-mcp-critical-capture.md` lus, leurs tâches terminées.
Contrôle processus Node read-only préalable : aucun runner navigateur concurrent
repéré ; résultat et heure conservés dans `process-preflight.json` et
`preflight-time.txt`.

Nouveau manifeste **1 696 fichiers**, tracked + untracked non ignorés : sources
produit, tests, scripts, configs et locks ; exclusions docs/Markdown/PDF,
dist/public/deps/cache/release/target. Comparaison avec `combined/.../initial.json` :
**exactement les trois inputs autorisés de focus-sync** ont changé :

- `packages/ui/tests/browser/git-history.test.ts` ;
- `packages/ui/tests/browser/session-rendering.test.ts` ;
- `packages/ui/tests/browser/fixtures/user-html.tsx`.

Comparaison des hashes de fichiers avec `mcp-critical/.../terminal-manifest.json` :
**aucun écart**. Aucun autre changement à déclarer ou autoriser ; hashes produit
inchangés depuis la validation combinée. `admission.json` conserve tous les hashes
anciens/nouveaux, chemins de référence et décisions. `browser-before.json` est
identique à l'admission ; le runner aurait refusé une dérive avant lancement.

SHA256 nouveau `initial.json` :
`da74db30b68829edd40b44c069191cba8b21cc3e5e5d345862eec0cb9a14eb1c`.
SHA256 combined initial historique :
`16a3d4085dac90c27e892a480ae4c0735eb52782a9add8b0ca6732a640f1a4df`.
Le manifeste MCP map-only est un format différent mais les hashes de fichiers
correspondent exactement : SHA
`4628acfc4df16f8e573da48dab23df3614a7a8a55643466e5e6e8e4f6e80105b`.

## Exécution normative et confinement

```powershell
$env:CODENOMAD_BROWSER_BOUNDARY_TRACE = '1'
npm run test:browser --workspace @codenomad/ui
```

Le script npm inchangé exécute
`node --import tsx --test --test-concurrency=1 tests/browser/*.test.ts`.
Pas de filtre, de liste privée substituée, de nouveaux délais/assertions/gestes,
ni de policy/cleanup du cache Vite. La capture MCP privée n'est **pas** insérée
dans ce fullbrowser : ses cinq passes restent ciblées/historiques, distinctes du
test MCP normal exécuté ici. Le trace opt-in préparé active uniquement les surfaces
focus/cache existantes. Aucun patch produit/test/fixture/script/config/deps/lock.

Le runner privé invoque la commande npm exacte via `cmd.exe /d /s /c`, depuis le
workdir exact, et conserve stdout/stderr sans filtrage dans `browser.log`.
Budget 60 minutes, exécution background avec notification de fin, pas de polling
répétitif. `started.json` créé en mode exclusif interdit un second lancement.
Si timeout, seule l'arborescence PID de ce runner npm privé est arrêtée, jamais le
daemon partagé ; timeout/forced se distinguent d'une sortie naturelle.

Artefacts :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-browser-final-0e81ac45520348328ab5bc06252a2010/`.
Runner `validate.cjs` SHA256 :
`2d31356e2f67899fc7a1207e145feb411907ff6f4bdc6bffa2842f12619e599d`.
Shell background : `sh_0f95dae060013DD7dMlptG7IAp`.

Aucun install, commit/push/merge, restart/déploiement, suppression de sessions,
accès au daemon/base/profil utilisateur, sous-agent ou autre gate. Les seuls edits
du validateur pour cette tâche sont ce rapport et les artefacts TEMP privés.

## Limites invariantes

Serveur/build/typechecks/A-B antérieurs restent historiques ; pas de nouvelle
exécution nécessaire ici puisque produit/scripts/locks sont identiques. Ce gate
ne qualifie ni Linux Electron → Windows LAN/OpenCode 2.0.19, ni la sortie naturelle
des stores. Un éventuel vert ne prouve pas l'élimination universelle des freezes
ni la cause des rouges précédents. Une panne HTML/Monaco/MCP reste rouge sans retry
et sans narration d'innocuité supposée.

Les snapshots sont ceux des tests existants. Si leur évaluation échoue, le log
complet doit conserver l'exception et le rapport distinguer `observation-error`
de l'échec produit/assertion ; un snapshot absent n'est pas un état vide démontré.
La mission et sa livraison terminale restent la décision du coordinateur.

## Résultat exact et captures

- Début UTC `2026-10-01T21:27:41.967Z`, fin `2026-10-01T21:47:52.008Z`.
- Durée runner **1 210 016 ms**, soit **20 min 10 s** ; durée Node test
  `1 209 656.4827 ms`. Notification finale reçue, pas statut déduit du dernier test.
- Exit 1, signal null, launchError null, timeout false, forcedExit false,
  naturalExit true. Aucune action d'arrêt du runner nécessaire.
- Total 360 = 358 pass + 1 fail + 0 cancelled + 1 skip, 0 todo, 0 suites.
- Skip : `Electron BrowserWindow native zoom retains tab seams and matching
  scrollbars`, opt-in `CODENOMAD_TEST_ELECTRON` absent. Ne pas confondre avec les
  autres fixtures Electron du corpus qui passent ; pas de qualification Linux/LAN.
- Node v25.2.1 Windows x64 ; Chromium par défaut Playwright, version 153.0.8010.12
  confirmée par les logs HTTP. `NODE_OPTIONS=--enable-source-maps` hérité inchangé.

### Unique échec — assertion et limite observationnelle distinctes

Cas : `central diff inserts local lines and revision-qualified history into the
real session composer`, durée cas `3316.8763 ms`, déclaration ligne 590.
Assertion rouge ligne **684** : expected `[]`, actual :

```text
ReferenceError: __name is not defined
    at <anonymous>:2:78
    at <anonymous>:2:1004
    at <anonymous>:3:7
```

Le cas a atteint le contrôle final après ses assertions de brouillon, références
Git, restitution de focus (`:630–632`), sélection de plage, historique de commit,
référence du worktree WSL, autorité de session et restauration de draft. Toutes
ces assertions ont donc passé **dans cette exécution**, malgré son statut final
rouge. Pas de timeout `activeElement`, de détachement/clic Monaco ou de replay.

Snapshot existant intégral, avant fermeture :

```text
Git focus boundary trace {
  events: [],
  active: { tag: 'BODY', id: '', className: 'enable-motion underline-links' },
  widgets: [],
  selections: []
}
```

**Observation-error distincte** : la collecte opt-in du script d'init n'a pas
produit de chronologie exploitable ; `__name` est un binding auxiliaire absent
dans le contexte navigateur. Le source de l'instrumentation (`:595–615`) initialise
le tableau puis définit un helper nommé `describe` et les listeners. Le mécanisme
attendu de transformation/sérialisation d'un helper par tsx/esbuild est cohérent
avec cette erreur, mais le JS exact sérialisé n'a pas été capturé : pas de preuve
supplémentaire par nouveau test ou expérience de transpilation dans cette tâche.

Le snapshot lui-même **n'a pas échoué à l'évaluation** : il est enregistré, sans
exception page.evaluate dans le résultat final. `events: []` ne démontre donc pas
l'absence de gestes/focus : la capture est défaillante. L'état BODY est celui de
la fin, après d'autres navigations ; il ne contredit pas l'assertion textarea passée
plus tôt. Les widgets absents en fin ne prouvent pas leur détachement pendant clic.
La régression observationnelle ne doit être ni attribuée au produit sur hypothèse,
ni ignorée pour déclarer ce gate vert.

### Frontières qui passent dans ce seul gate

- MCP `reduce, 150% scale` static rest : pass `1619.5347 ms` ; autres trois cas MCP
  pass également. Test normal, aucune substitution/capture MCP privée insérée.
- HTML/cache : `user HTML mode preserves Markdown, pasted disclosures and code
  source and fences legacy caches` pass `2196.9656 ms`. Aucune exception/snapshot
  d'échec HTML imprimé, donc pas de nouvelle attribution du timeout ancien.
- Les 358 passes restent celles du corpus normal, pas additionnées aux
  retries ni aux résultats historiques. Les erreurs de bootstrap antérieures
  restent non attribuées ; aucun claim d'innocuité universelle.

## Empreintes et livraison terminale

`browser-before.json` et `browser-after.json` sont strictement identiques à
`initial.json`, SHA `da74db30b68829edd40b44c069191cba8b21cc3e5e5d345862eec0cb9a14eb1c`.
1 696 fichiers ; `drift: []`, `driftFromInitial: []`, HEAD inchangé.
Le runner exécuté conserve son SHA d'admission. L'immuabilité est constatée aux
bornes, pas un verrou filesystem pendant le run.

| Artefact privé | SHA256 |
| --- | --- |
| `browser.log` brut complet | `f24b7866e58109e029acdda5947caa24ce282f78818ff4ddd0a69b220f845eea` |
| `failures.log` extrait intégral du résumé rouge | `7db7e5c1ecfaf693f0540ea5d732df0c1f34435b55465012a5cf7bced8a3b5f9` |
| `boundary-output-through-end.log` trace puis suite jusqu'à fin | `fa7ef5a8b580e05cc810ac80af67fce3f18949c5d600e47e4981bdaad3b45b5f` |

`browser-result.json` conserve commande/statut/heures/durée/exits/manifests ;
`summary.json` vérifie compteurs et hashes ; `git-focus-snapshot.log` conserve le
snapshot exact, `boundary-observation-status.json` distingue l'observation-error
du contrôle `errors=[]` rouge et du snapshot évalué avec succès. Le postprocesseur
privé `summarize.cjs` ne lance aucun test/browser et ne filtre pas le log brut.

Serveur/build/typechecks/A-B ne sont pas rejoués ; leurs preuves historiques sur
produit identique restent qualifiées avec leurs limites déjà rapportées. Aucun
nouveau gate, correction, cleanup ou déploiement ajouté pour fabriquer du vert.

## Prochain minimum utile — décision coordinateur

Remettre ce **gate rouge unique** et les captures au propriétaire de focus-sync :
rendre le script opt-in navigateur autosuffisant à la sérialisation (par exemple
source JS explicite sans helper Node externe), sans modifier contrat produit,
assertions, délais ou gestes. C'est une recommandation bornée, **pas un patch ou
une relance autorisée ici**. Le coordinateur décide s'il faut un suivi séparé ou
s'il clôture avec cette limite ; aucune nouvelle boucle d'audit/retry du validateur.
