# Issue 824 — correction de sérialisation de la trace Git

## Verdict

Le défaut introduit par l'instrumentation opt-in est corrigé uniquement dans
`packages/ui/tests/browser/git-history.test.ts`.

La cause est démontrée : sous le loader `tsx` réellement installé, le callback
TypeScript passé à `page.addInitScript(callback)` devient une fonction dont
`toString()` contient :

```js
const describe = __name(target => /* ... */, "describe")
```

Playwright sérialise le corps de la fonction mais pas le helper module-scope
`__name`. Une page Chromium minimale reproduit alors exactement
`ReferenceError: __name is not defined`, avec le même stack et une trace vide que
le gate final.

Le script est maintenant fourni par `page.addInitScript({ content })` sous forme
de source JavaScript explicite et autosuffisante. Aucun helper global n'est injecté
pour cacher l'erreur. Une validation Chromium minimale du contenu exact extrait du
fichier est verte : aucune erreur page, 200 entrées bornées après saturation, et
les observations focus, pointer/click et `widget-removed` restent actives.

Le gate final précédent demeure **non vert** : 360 total, 358 pass, 1 fail,
1 skip, exit 1 naturel. Aucun fullbrowser ni test ciblé Git/session/MCP n'a été
relancé dans cette tâche.

## Changement exact

Le callback transformable de `addInitScript` est remplacé par la constante
`gitFocusBoundaryInitScript`, un `String.raw` contenant une IIFE JavaScript sans
types ni closure externe. `describeElement` et `pushTrace` vivent entièrement dans
ce contexte navigateur.

Toutes les observations passent par `pushTrace`, y compris `widget-removed` ; la
limite de 200 entrées couvre donc désormais toute la chronologie, et pas seulement
les événements focus/pointer.

Le snapshot final est entouré d'un `try/catch` observationnel. Une évaluation de
snapshot indisponible est journalisée comme telle et ne masque plus une assertion
déjà en cours ; `page.close()` reste exécuté après ce bloc. Aucun changement aux
assertions, à `errors[]`, aux clics, textes, sélections, délais ou à la
synchronisation focus précédemment acceptée.

## Preuve rouge causale

Artefact privé :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-browser-trace-serialization-fix/red.json`.

Le fichier `callback-before.ts` recopie exactement le callback remplacé. Il est
importé par `node --import tsx`; la fonction obtenue est passée à
`page.addInitScript` dans une page `data:` privée.

Résultat :

```json
{
  "hasExternalName": true,
  "errors": ["ReferenceError: __name is not defined ..."],
  "snapshot": { "trace": [] }
}
```

Le champ `serialized` de l'artefact conserve le JavaScript exact, dont
`const describe=__name(...)`. SHA256 `red.json` :
`1A3271EB26B265784BD84EBF2D4A7546508551BEF04237156CAEF779586C117F`.

Ce mécanisme est certain, et non une simple corrélation : la transformation exacte,
le binding externe absent, l'exception Chromium et l'état vide correspondent tous
au gate. L'ajout de `__name` vient de la transformation `tsx` effective ; aucune
hypothèse sur Vite, Monaco ou le produit n'est nécessaire.

## Preuve verte bornée

`validate.cjs` lit `git-history.test.ts`, extrait le contenu exact du
`String.raw`, puis l'injecte avec `{ content }` dans une page Chromium minimale. La
page alterne le focus 260 fois, émet `pointerdown` et `click`, puis retire un widget
`.git-change-context-widget` après installation du MutationObserver.

Résultat :

```json
{
  "hasExternalName": false,
  "errors": [],
  "traceLength": 200,
  "hasFocus": true,
  "hasPointer": true,
  "hasWidgetRemoved": true,
  "lastKinds": ["focusout", "focusin", "pointerdown", "click", "widget-removed"]
}
```

Le budget saturé à 200 et l'entrée `widget-removed` finale démontrent à la fois la
borne globale et la persistance des listeners/observer après saturation.

Artefacts :

- `green.json`, SHA256
  `D3024DB5252E029100F2C5D99F28A22F5F7AA186B43C254C0F1AC622CB6554F0` ;
- `validate.cjs`, SHA256
  `9AB9E82D41BF8FAE98913DBF2BB9F22C8DA48C61335C47A32B04D7857F336087`.

Deux premiers lancements du runner privé n'ont pas atteint Chromium : le premier
ne résolvait pas `playwright` depuis TEMP, le second contenait des séparateurs de
ligne PowerShell littéraux. Ils ont échoué respectivement avec `MODULE_NOT_FOUND`
et `SyntaxError`; le runner final résout explicitement les dépendances depuis le
worktree. Ces erreurs de préparation ne sont pas comptées comme rouge/vert produit.

## Contrôles statiques et empreintes

- `npm run typecheck --workspace @codenomad/ui` : exit 0.
- `git diff --check -- packages/ui/tests/browser/git-history.test.ts` : exit 0,
  avec le seul avertissement LF/CRLF existant.
- Aucun fichier produit modifié par cette tâche.

Manifest privé :
`C:/Users/Admin/AppData/Local/Temp/opencode/issue-824-browser-trace-serialization-fix/manifest.json`,
SHA256 `90405BE5AE1A1BF9C328B226AA3634FB7B49B7C5D754A4B23F569193FD551F32`.

Par rapport au gate final :

- `git-history.test.ts` :
  `CD4776C4B035FE2C19A80BC7F562FC916A0B4F3388DAD7F1C0A13F683E18DEE4`
  → `DC7C378CC15E54F22F5D7E1A4C485313F0AF9DF536E1544690A33E3B2B2E5264` ;
- `session-rendering.test.ts` reste
  `D50A2932039D3E44FA06BF1E02AA75D108A6C80520CE15724D229A1FEBA4E982` ;
- `fixtures/user-html.tsx` reste
  `3D7616C20EDCFA32A7388E473C877B89089DA76FA482CD2E91C1160F95AAD631`.

Les quatre empreintes produit suivies restent celles du gate/focus-sync :

- `monaco-diff-viewer.tsx` : `3EB01E2C6D255E41A92FDCACBF946455B7A87293B19F3389D4FAE5C1381C3142` ;
- `session-view.tsx` : `733C02DE156A75ECD0D2F7C6DCD90A25050C0A1FC5D8EFD2F0E975D649C4E9AB` ;
- `prompt-input.tsx` : `9C8BE5BE1336A11E3188F94716DC3BAE6B63C1EB96BF20DF1F31913318345328` ;
- `markdown.tsx` : `51EE39FE0CC2FF5CF4258221B48919EF41AE9C3592450DF9D3FAF4EF0D2C3456`.

Ainsi, parmi les trois inputs qui distinguaient le gate final de la validation
combinée, seul le script Git opt-in change dans cette tâche. Le manifeste immuable
1 696 fichiers du gate reste une preuve historique, pas le manifeste du nouvel
état.

## Limites et prochain pas

La validation prouve la sérialisation, l'absence de `pageerror`, la borne et
l'activité de la capture dans un DOM minimal. Elle ne rejoue pas le composant
Monaco, les assertions Git ni le corpus complet, conformément à l'interdiction.

Le plus petit prochain pas est une décision du coordinateur : conserver le bilan
terminal comme non vert avec ce défaut de test causalement corrigé, ou autoriser
ultérieurement un unique gate d'acceptation sur une composition figée. Aucun retry,
patch produit ou promesse d'élimination universelle de #824 ne découle de cette
preuve.
