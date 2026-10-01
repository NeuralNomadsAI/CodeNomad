# Issue 824 — synchronisation du test focus et traces de frontière

## Résultat

La seule correction fonctionnelle est dans
`packages/ui/tests/browser/git-history.test.ts` : après les deux assertions de
contenu, le test attend maintenant causalement que le textarea déjà résolu soit
`document.activeElement`, puis conserve l'assertion d'identité existante.

Cette attente utilise le délai Playwright existant. Aucun sleep, timeout explicite,
retry, force-click, changement de sélection ou changement du contrat focus produit
n'a été ajouté.

Le focus corrigé passe **2/2**. Le second run a toutefois reproduit exactement le
timeout `.cached-html` indépendant. Le résultat ciblé global est donc un run vert
puis un run rouge; il ne constitue pas un gate navigateur vert et ne démontre pas
une correction universelle de #824.

## Diff exact

### Synchronisation focus

Après les assertions inchangées du brouillon et du contexte Git :

```ts
const composerElement = (await composer.elementHandle())!
await page.waitForFunction(element => element === document.activeElement, composerElement)
assert.equal(await composer.evaluate(element => element === document.activeElement), true)
```

Le textarea est capturé après l'insertion. L'attente observe uniquement la
restitution asynchrone du focus déjà prévue par `insertBlockContent()`.

### Instrumentation observationnelle, désactivée par défaut

`CODENOMAD_BROWSER_BOUNDARY_TRACE=1` active désormais :

- pour la fixture Git, les événements `focusin`, `focusout`, `pointerdown` et
  `click`, le retrait éventuel du widget Monaco, l'élément actif final, la
  connectivité/position des widgets et la sélection Monaco disponible ;
- pour la fixture HTML, la valeur `literal`, le DOM/connectivité de `#cache`, les
  mutations, les points avant/après setter, le `renderCache`, les ressources de
  module pertinentes, les `pageerror`, consoles et requêtes échouées.

En mode normal, la fixture HTML expose directement le setter Solid original. Les
observers et wrappers de trace ne sont créés que lorsque la variable opt-in ajoute
`trace=1`; seul un snapshot en lecture est disponible pour le dump d'échec déjà
existant. Assertions, délais et chemin normal restent inchangés.

Cette instrumentation prépare le prochain gate unique; elle n'a pas été utilisée
pour relancer le cas après le timeout, conformément à la limite de deux runs.

## Validation bornée

Commande exacte, concurrence 1 et noms exacts, exécutée deux fois :

```powershell
node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 \
  --test-name-pattern="^(central diff inserts local lines and revision-qualified history into the real session composer|user HTML mode preserves Markdown, pasted disclosures and code source and fences legacy caches)$" \
  packages/ui/tests/browser/git-history.test.ts \
  packages/ui/tests/browser/session-rendering.test.ts
```

Résultats :

1. exit `0`, 2 pass : focus 12,3 s; cache HTML 9,4 s;
2. exit `1`, focus pass 12,7 s; cache HTML timeout 38,8 s sur
   `page.locator("#cache .cached-html").waitFor()`.

Le dump du second run est celui d'avant instrumentation et indique
`state: undefined`; il ne qualifie donc toujours pas la cause cache. Il établit en
revanche que le timeout antérieur est reproductible sur les mêmes sources et doit
rester une frontière ouverte, séparée de la correction focus.

Autres contrôles :

- `npm run typecheck --workspace @codenomad/ui` : exit `0` après instrumentation ;
- `git diff --check` sur les trois fichiers de test/fixture : exit `0`, avec
  avertissements de conversion LF/CRLF seulement ;
- aucun fullbrowser relancé.

## Empreintes

Artefacts privés :

- `C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-focus-test-sync/manifest.json`
  — SHA256 `8440F3A61D0B59C870E1A64F9AAEFF90F68B5969FD5C77510F82AB2C899C543D` ;
- `run-1.log` — SHA256
  `5354F36A00380DC16397A394C09B58FBD25D4AE3D613EF026024986077080E69` ;
- `run-2.log` — SHA256
  `0499BDEFAB8EC34349CD2C63E1D0402CB1324AF98FF6567E984F5A1F6B15E63B`.

Le manifest contient les SHA256 avant/après de huit inputs. Seuls les trois inputs
de test autorisés ont changé :

- `packages/ui/tests/browser/git-history.test.ts` ;
- `packages/ui/tests/browser/session-rendering.test.ts` ;
- `packages/ui/tests/browser/fixtures/user-html.tsx`.

Les quatre inputs produit fingerprintés sont strictement identiques avant/après :
`monaco-diff-viewer.tsx`, `session-view.tsx`, `prompt-input.tsx` et `markdown.tsx`.
`fixtures/git-history.tsx` est également inchangé.

Le manifest de la validation combinée et le manifest du diagnostic précédent sont
désormais des preuves **historiques**, car `git-history.test.ts` a volontairement
changé. Ils ne fingerprintent pas ce nouvel état de test.

## Limites et prochain gate

- La panne distincte de clic/détachement du widget Monaco n'a pas récidivé dans ces
  deux runs et n'est ni corrigée ni masquée.
- Le timeout cache a récidivé une fois; aucun patch Markdown/Solid/Vite n'est
  justifié sans la nouvelle trace opt-in.
- Aucun test au-delà des deux noms ciblés n'a été exécuté. Le fullbrowser précédent
  reste non vert.

Après la fin des diagnostics encore en file, exécuter un seul gate navigateur sur
sources figées avec `CODENOMAD_BROWSER_BOUNDARY_TRACE=1` et conserver l'artefact
complet si cache ou overlay échoue. Ne pas ajouter de retry pour fabriquer un gate
vert. Toute correction ultérieure du cache ou de Monaco doit partir de cette trace
causale et rester hors de cette tâche.

## Fichiers volumineux touchés

- `packages/ui/tests/browser/session-rendering.test.ts` : environ 910 lignes, sous
  le seuil d'alerte test de 1000 lignes mais proche ; aucun refactor de portée n'a
  été entrepris.
