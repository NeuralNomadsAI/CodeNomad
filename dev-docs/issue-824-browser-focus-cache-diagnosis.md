# Issue 824 — attribution bornée des échecs navigateur focus et cache HTML

## Verdict

Diagnostic borné terminé, sans correction produit ni test.

- **Focus après insertion Git : course de synchronisation du test confirmée par
  le contrat du produit; défaut produit #824 non démontré.** Le texte est inséré
  immédiatement, mais la restitution du focus est volontairement programmée dans
  une tâche `setTimeout(0)`. L'assertion du test ne synchronise pas cette tâche.
- **Cache HTML : non reproduit et non attribué.** Le chemin attendu après
  `literal(false)` est un hit de cache local synchrone, pas une attente du renderer
  Markdown. Les preuves disponibles ne permettent pas de choisir entre défaut de
  réactivité ponctuel, cache Vite/optimisation du harness ou scheduling du run
  complet.
- Une panne différente a été reproduite une fois avant la frontière focus : le
  widget Monaco a été détaché pendant le clic. Elle confirme que cette fixture a
  une frontière overlay/DOM instable, mais n'explique pas l'assertion
  `activeElement` originale et ne doit pas être renommée en régression #824.

Le gate navigateur complet de la validation combinée reste **non vert**. Les
succès ciblés présents ne le remplacent pas.

## Inputs et identité

Sources du worktree `issue-824-performance`, HEAD `366830f6`, modifications mission
non committées. Node `v25.2.1`, Chromium `153.0.8010.12`, rejets non gérés stricts,
concurrence de tests 1. Aucun produit, test, fixture, dépendance ou configuration
n'a été modifié.

Artefact privé :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-focus-cache-diagnosis/diagnosis.json`,
SHA256 `F9ABE8BEC0A7A4940B9357448A37AC3AAB1A497BC4C8D8267E0495752ADDB5EA`.
Il enregistre les quatre répétitions et les SHA256 des huit inputs lus/exécutés.
Les quatre hashes test/fixture pris avant les runs sont identiques à ceux de
l'artefact final :

- `git-history.test.ts` : `1F779351772617138C12694D2236FFADCB557BA85E070E64A04C1CBEE7CC049F`;
- `fixtures/git-history.tsx` : `6C73B4FC43D1D4C0B32AB52733919751EBA9FB89BA4E905B542D9B8423C1E1EC`;
- `session-rendering.test.ts` : `DE5F5AE9E6F70428860FBD9089E7CC8EF3F87965B6DB6E164EDEEE000626B578`;
- `fixtures/user-html.tsx` : `904C3CA2B72B4CE7A2272762557C3BD2D3E06FCC7BDDC0310B9D044F5538E660`.

Les inputs produit effectivement inspectés et fingerprintés sont
`monaco-diff-viewer.tsx`, `session-view.tsx`, `prompt-input.tsx` et `markdown.tsx`;
leurs hashes complets sont dans l'artefact. Aucune instrumentation source n'a été
nécessaire.

## Focus Git : attribution

### Frontière exacte

1. Le bouton overlay empêche le `mousedown` par défaut afin de ne pas voler la
   sélection Monaco, puis appelle synchroniquement `onRequestInsertContext`.
2. `GitDiffView` produit le texte qualifié; `SessionView.handleInsertPreviewComment`
   appelle `PromptInputApi.insertComment`.
3. `insertComment` appelle `insertBlockContent`. Celui-ci fait immédiatement
   `setPrompt(nextValue)`, puis programme seulement dans `setTimeout(..., 0)` :
   `textarea.focus()` et `setSelectionRange()`.
4. Le test clique, lit deux fois `composer.inputValue()` puis évalue immédiatement
   `element === document.activeElement`. Les lectures de valeur ne constituent pas
   une attente contractuelle de la tâche timer.

Le run complet original a donc démontré exactement ce que ce séquençage autorise :
les deux assertions de contenu passent, puis l'identité de focus est encore fausse
à l'instant observé. Il n'a démontré ni perte de brouillon, ni mauvaise cible, ni
absence durable de restitution du focus.

### Replays présents et nouveaux

La validation combinée avait déjà un replay exact vert et une suite voisine verte.
Sur quatre nouvelles répétitions bornées :

- répétitions 1 et 2 : test complet vert;
- répétition 3 : n'atteint pas l'assertion; timeout de 30 s dans `insert.click()`.
  Playwright rapporte que `<html>` intercepte les pointer events, puis que le
  bouton overlay est détaché pendant le retry;
- répétition 4, focus seul : test complet vert.

Ainsi l'échec `false !== true` original reste non reproduit dans ce suivi, mais sa
cause de test est expliquée par une absence de synchronisation observable dans le
code. La panne de clic séparée interdit de qualifier la fixture comme parfaitement
stable.

### Disposition minimale

Ne pas changer le produit sur cette preuve. Si un gate navigateur entièrement vert
est exigé, le plus petit ajustement de test est d'attendre causalement que le
textarea devienne `document.activeElement`, dans le délai existant, puis conserver
l'assertion d'identité. Ne pas ajouter de sleep, force-click ou retry global.

La panne overlay distincte mérite, seulement si elle récidive au gate de livraison,
une trace opt-in de `widgetPosition`, sélection Monaco, bounding box et événements
`focusin/focusout`/pointer autour du clic. Elle ne doit pas être masquée par
`click({ force: true })`.

## Cache HTML : attribution

### Frontière exacte

Le fixture monte un `Markdown` avec une part dont `renderCache` contient :

```text
mode = 1:escaped:wrap
html = <div class="cached-html">old sanitized HTML</div>
```

En mode initial `literal(true)`, le mode résolu est `1:literal:wrap`; ce cache est
donc correctement refusé. Après `literal(false)`, avec `escapeRawHtml` toujours
vrai, le mode devient exactement `1:escaped:wrap`. L'effet de `Markdown` doit alors
prendre `snapshot.part.renderCache`, exécuter `setHtml(localCache.html)` et retourner
avant `renderSnapshot()`. L'apparition de `.cached-html` ne dépend donc ni du
chargement du module Markdown, ni de Shiki, ni d'une promesse de highlighting.

Le timeout original signifie que cette transition synchrone n'a pas été observée
dans le DOM. Sans trace de la valeur du signal, du nombre d'exécutions de l'effet,
de l'identité du nœud `#cache`, des erreurs page/module ou des mutations DOM, il est
impossible de distinguer :

- effet Solid non relancé ou runtime optimisé incohérent dans ce serveur Vite;
- fixture/nœud remplacé pendant le run complet;
- autre anomalie de scheduling ou de cache du harness.

Une lenteur ordinaire de rendu Markdown est écartée par le chemin de cache local.
Un défaut produit persistant est affaibli par les preuves : replay exact vert,
suite `session-rendering` complète verte (46 tests), puis trois nouvelles
répétitions cache **3/3 vertes** sur sources identiques.

### Disposition minimale

Aucun patch produit justifié. Ne pas demander davantage de retries ciblés. Si le
même timeout réapparaît dans un prochain gate complet autorisé, capturer dans le
failure artifact, sans modifier assertion ni délai :

- valeur courante de `literal` et compteur d'exécutions de l'effet;
- `#cache.innerHTML`, connectivité/identité du nœud et MutationObserver;
- `pageerror`, console, `requestfailed` et URLs des chunks Vite/Solid chargés;
- mode/cache key résolus avant et après le setter.

Cette trace permettra de tester causalement l'hypothèse de cache d'optimisation
Vite partagé. Introduire un `cacheDir` privé peut ensuite être évalué par contrôle
négatif; le succès isolé seul ne prouverait pas cette cause.

## Exécutions bornées

Commande à deux noms exacts exécutée trois fois, puis focus seul une fois :

```powershell
node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 \
  --test-name-pattern="^(central diff inserts local lines and revision-qualified history into the real session composer|user HTML mode preserves Markdown, pasted disclosures and code source and fences legacy caches)$" \
  packages/ui/tests/browser/git-history.test.ts \
  packages/ui/tests/browser/session-rendering.test.ts
```

Résultats : focus 3 passages complets verts et 1 timeout de clic préalable; cache
3/3 vert. Durées des quatre processus : environ 24,9 s, 22,8 s, 54,7 s et 15,0 s.
Sorties naturelles; la troisième sort avec code 1 sur timeout Playwright. Aucun
fullbrowser, stress, installation, daemon/profil/base utilisateur, restart,
déploiement, commit, push ou sous-agent.

## Décision pour le gate de livraison

Conserver séparément :

1. le fullbrowser 356/3/1 à exit 1;
2. ses retries et suites ciblées vertes;
3. ce diagnostic, qui attribue la course focus au test mais laisse le timeout
   cache non qualifié et révèle une panne overlay distincte.

Si le critère de livraison exige un fullbrowser vert, appliquer uniquement la
synchronisation causale du focus après décision du coordinateur, instrumenter le
cache/overlay de manière opt-in au prochain gate complet, puis exécuter **un** gate
figé. Ne pas présenter les replays ciblés comme un gate final vert.
