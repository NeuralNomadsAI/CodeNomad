# Issue 824 — revue indépendante de l'intégration UI

## Verdict

**Corrections demandées avant validation finale**, pour un défaut de membership
du renderer `task` confirmé ci-dessous. Le coalescing du compactage et la
séparation des diagnostics SSE sont acceptables dans leur périmètre; aucun défaut
de perte de texte, d'ordre ou de fence n'a été reproduit sur ces surfaces.

Revue bornée au diff depuis `366830f6` de `opencode-data.ts`, `instances.ts`,
`compaction-delta-buffer.ts`, `task.tsx`, `server-events.ts`,
`event-source-handlers.ts` et de leurs fixtures. Aucun fichier produit n'a été
modifié par cette revue.

## Findings

### M1 — une suppression autoritaire d'une part tool laisse une clé fantôme dans le renderer `task`

Dans `task.tsx`, la mise à jour incrémentale ne traite que
`nextPartCount > previousPartCount`. Si une page autoritaire conserve le message
mais retire une part tool, `nextPartCount < previousPartCount` ne déclenche ni
rescan ni retrait de `childToolKeys`.

La ligne supprimée disparaît malgré tout parce que `TaskToolCallRow` ne trouve
plus sa part et son `Show` se démonte. En revanche, la clé reste dans
`childToolKeys` : le compteur et la troncature sont faux, et un ajout ultérieur
qui ramène le nombre de parts à sa valeur précédente peut ne pas être indexé.

Reproduction indépendante avec le vrai composant, le vrai store et
`loadMessages(..., { force: true })`, via une transformation Vite en mémoire qui
retire seulement `step-0` de la réponse native :

```json
{"count":"2 steps","visible":1,"partIds":["step-1"]}
```

La reproduction directe déjà exposée par le fixture donne le même état. Le test
vert actuel `removeTool(0)` affirme uniquement que le DOM de `step-0` est détaché;
il n'affirme ni `1 step`, ni la membership, ni l'ajout suivant. Le test de page
vide couvre une baisse du nombre de messages et prend une autre branche de full
rescan.

Correction minimale recommandée : full rescan borné dès qu'un nombre de parts
d'un message indexé diminue (et, si les pages peuvent remplacer des identités à
cardinalité égale, comparer aussi l'identité bornée des parts). Ajouter un cas
page autoritaire 2→1 dans le même message, puis ajout d'une nouvelle part 1→2;
le shell de la part non supprimée doit rester monté, le compteur doit faire
2→1→2 et la nouvelle clé doit apparaître exactement une fois.

### R1 — l'accumulateur de compactage est borné dans le temps, pas en taille

Le timer part du premier fragment et n'est jamais repoussé : avec de vrais
événements EventSource échelonnés, la résidence est donc bornée à environ 250 ms.
En revanche, tant que la boucle ne rend pas la main, le nombre de fragments et la
taille de la chaîne concaténée n'ont pas de plafond explicite. Le gros backlog
synchrone du diagnostic peut toujours construire un unique payload volumineux.

Ce n'est pas bloquant pour le correctif revendiqué : le transport produit livre
ici un événement par callback, les nouveaux tests de cadence rendent réellement
la main, et le résumé final doit de toute façon exister en mémoire. Ne pas appeler
le buffer « borné en mémoire ». Si une mesure réelle montre une rafale sans
yield, ajouter une limite qui force une réduction intermédiaire sans supprimer ni
réordonner de texte; ne pas introduire un drop silencieux.

### T1 — le test store compactage ne fournit pas une sortie naturelle

Les 11 assertions passent avec rejets stricts, mais le processus reste vivant
au-delà de 120 s sans `--test-force-exit`. Avec l'option de force, 11/11 passent
en 0,77 s. Cela correspond à la convention déjà déclarée pour les stores importés
et ne démontre pas une fuite du nouveau buffer, mais ce fichier seul ne constitue
pas un gate de lifecycle naturel. Les 10 tests navigateur intégrés ci-dessous
sortent naturellement.

## Contrats compactage vérifiés

- Chaque delta avance immédiatement `messageRevisions`, `fullDataRevisions` et
  la fence de lecture du reducer observé; l'agrégat réentrant n'avance pas ces
  révisions une seconde fois.
- Un buffer est séparé par couple instance/session. Un événement non-delta de la
  même session force l'ordre; les autres sessions et instances ne forcent pas le
  flush.
- `ended` et `failed` annulent les fragments car le SDK 2.0.21 remplace le résumé
  par `ended.data.text` ou remplace la ligne par l'erreur. Delete, reconnect,
  prune, revert committed et dispose annulent aussi avant qu'un timer puisse
  ressusciter le contenu.
- Une lecture SDK déclenchée avant admission est refusée par révision. Une lecture
  après admission force d'abord l'agrégat; la page native qui contient déjà ce
  texte n'est pas réappendue.
- Rotation à 200 messages, idle, nouvelle exécution et second start conservent
  l'ordre. La queue de rotation et la resynchronisation autoritaire restent les
  fences existantes.
- Une session inactive jamais chargée ne crée pas de transcript ni de payload de
  reducer; seules les fences scalaires et le marqueur de compaction inachevée
  persistent. End/failed/dispose les retirent. Une activation intermédiaire passe
  par la page autoritaire, conserve la fenêtre UI de 200 messages et reprend
  ensuite le streaming sans duplication.
- Une session chargée puis inactive réduit l'agrégat mais n'hydrate pas sa vue
  cachée; son retour recharge le texte exact.

Les cinq scénarios navigateur utilisent le vrai `SessionView`, le dispatcher
natif et les stores. Le cas cadencé livre huit événements dans huit tâches
séparées par 10 ms; ce n'est pas uniquement le backlog synchrone historique.

## Renderer imbriqué : propriétés validées hors M1

- Les getters réactifs mettent à jour output, copy et erreurs sans remonter le
  shell d'une clé stable; disclosure, scroller et scrollTop restent conservés.
- Le `Show keyed` externe remonte le shell quand `Index` réutilise une position
  pour une autre clé, donc l'état d'une étape évincée n'est pas transféré.
- Une invalidation de lecture conserve le snapshot résident; le full rescan après
  retour autoritaire et la page vide suppriment les messages obsolètes.
- La limite de scan reste 10 000 unités et l'affichage 200 étapes. Le patch ne
  rend pas le scan ou le nombre de shells non borné.
- L'output d'une page native à révision de part zéro utilise de nouveau son hash
  Markdown et n'affiche pas le cache de l'ancienne page.

## Diagnostic SSE / flush Solid

La correction ne prétend plus capturer une dérivation Solid dans le `try/catch`
de chaque abonné. Elle sépare correctement les frontières : JSON invalide produit
`Failed to parse event`; une exception qui sort du flush de `solidBatch` produit
`Failed to dispatch event`. Elle ne déclenche ni reconnexion ni rejeu, et les
événements suivants continuent en FIFO. Le test navigateur dérivé traverse le
vrai EventSource et confirme les deux événements chez les abonnés natif et typé.

Les risques déjà acceptés restent inchangés : ce logger `debug` est désactivé par
défaut, et la course serveur abort local / erreur amont n'est pas couverte ici.
Aucune nouvelle promesse de diagnostic persistant ou d'isolation du flush n'est
faite.

## Gates exécutés

- `node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 packages/ui/tests/browser/compaction-responsiveness.test.ts packages/ui/tests/browser/event-subscriber-isolation.test.ts` — **10/10**, sortie naturelle.
- `node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern="^(unrelated child text|a failed child refresh|native page output|changing an indexed task key)" packages/ui/tests/browser/render-cost.test.ts` — **4/4**, sortie naturelle.
- `node --conditions=browser --unhandled-rejections=strict --import tsx --test packages/ui/src/lib/event-source-handlers.test.ts` — **4/4**, sortie naturelle.
- `node --conditions=browser --unhandled-rejections=strict --import tsx --test packages/ui/src/stores/opencode-compaction.test.ts` — **11 assertions vertes**, mais timeout de lifecycle à 120 s.
- Même test avec `--test-force-exit` — **11/11**, 0 échec.
- `npm run typecheck --workspace @codenomad/ui` — vert.
- `git diff --check` ciblé — vert, hors avertissements LF/CRLF du worktree.

Les deux reproductions ad hoc du finding M1 ont utilisé un serveur Vite et un
Chromium privés loopback, sans fichier temporaire dans le dépôt, daemon, profil,
base utilisateur, restart ou déploiement.

## Taille des fichiers

- `packages/ui/src/stores/opencode-data.ts` : ~828 lignes, au-dessus de la cible
  de 800.
- `packages/ui/src/stores/instances.ts` : ~2 093 lignes, très au-dessus de la
  cible.
- `packages/ui/src/components/tool-call/renderers/task.tsx` : ~647 lignes,
  au-dessus du seuil d'avertissement.
- `packages/ui/src/stores/compaction-delta-buffer.ts` : 56 lignes.

Aucun refactor de taille seul n'est recommandé dans cette mission.

## Addendum — disposition du finding M1

### Verdict de suivi

**M1 est clôturé.** La correction de membership intégrée après la revue initiale
traite les suppressions, remplacements et réordonnancements autoritaires sans
réintroduire les remounts qui motivaient le correctif de performance. Le verdict
« corrections demandées » ci-dessus est donc levé pour cette surface. Les
observations R1 et T1 restent des limites non bloquantes, inchangées.

Cette disposition repose sur une revue indépendante du nouveau diff de
`task.tsx`, `render-cost.test.ts` et `fixtures/render-cost.tsx`; elle ne fusionne
pas les chiffres A/B historiques avec les mesures de ce suivi.

### Pourquoi la clé fantôme ne subsiste plus

- À chaque révision de session, le renderer recalcule les identités structurelles
  dans le budget existant, au lieu de ne détecter que l'augmentation du nombre de
  parts. Une baisse 2→1, un retour 1→2, un remplacement/reorder 2→2 et une part
  passée de `tool` à `text` sont donc tous visibles.
- Le scan reste borné par `TASK_MESSAGE_SCAN_LIMIT = 10_000` et collecte au plus
  `TASK_STEP_RENDER_LIMIT + 1`, puis affiche les 200 dernières clés.
- Si la séquence de clés est strictement identique, le setter conserve le tableau
  précédent. Si elle change, `<For>` associe les lignes aux valeurs de clé plutôt
  qu'à leur position : les clés retenues conservent leur composant et leur état,
  tandis que les nouvelles identités obtiennent un shell neuf.
- Le snapshot résident reste affiché pendant une lecture invalide; le rescan se
  fait sur le retour autoritaire. Une erreur conserve toujours le snapshot et le
  retry existants.

### Régressions discriminantes

Les nouveaux cas vrais composants/stores/pages natives vérifient :

1. suppression puis ajout dans le même message, pour chacune des deux positions
   initiales : compteur `2→1→2`, nouvelle clé unique, shell/disclosure/scroller et
   `scrollTop` de la clé retenue inchangés;
2. remplacement et reorder à cardinalité égale : ordre exact `[step-2, step-0]`,
   `step-1` absent et shell de `step-0` conservé;
3. identité de part identique dont le type passe de tool à texte : compteur réduit
   et ligne supprimée;
4. fenêtre `201→199` : toujours 200 éléments maximum, puis 199, sans diagnostic de
   troncature obsolète;
5. 80 étapes soumises aux deltas de texte non structurels : chaque échantillon
   conserve `added=0` et `removed=0`. Les 80 snapshots de données déjà documentés
   restent présents; aucune nouvelle revendication ne les élimine.

### Validation fraîche du suivi

- `node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 packages/ui/tests/browser/render-cost.test.ts` — **13/13**, sortie naturelle (~45 s).
- `node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 packages/ui/tests/browser/task-copy.test.ts packages/ui/tests/browser/tool-images.test.ts` — **9/9**, sortie naturelle (~37 s).
- `npm run typecheck --workspace @codenomad/ui` — vert.
- `git diff --check` sur les trois fichiers revus et ce rapport — vert, hors
  avertissement LF/CRLF du worktree.

Échantillon descriptif frais des dix deltas à 80 étapes : temps de tâche entre
environ **9,2 et 16,1 ms**, temps synchrone rapporté entre **0,1 et 0,3 ms**, avec
`added=0` et `removed=0` pour chaque échantillon. Il s'agit d'un fixture Chromium
de développement et non d'un nouveau benchmark desktop ou d'une garantie FPS.

Aucun daemon, profil, base utilisateur, restart, déploiement, dépendance, commit
ou push n'a été utilisé pour ce suivi.
