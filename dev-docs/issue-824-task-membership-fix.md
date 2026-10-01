# #824 — correction M1 de membership des étapes imbriquées

## Résultat

Le finding M1 de `issue-824-ui-review.md` est corrigé dans le worktree mission.
Les cinq nouvelles régressions échouent sur le renderer livré avant cette tâche,
puis **68/68 tests navigateur** passent sur le renderer corrigé, avec rejets stricts,
sortie naturelle, aucun skip/force-exit/force-click. Les shells conservés gardent
leur disclosure, leur scroller et leur scrollTop après suppression ou déplacement.
Le contrôle instrumenté de 80 étapes conserve **zéro retrait/insertion par delta**.

Cette tâche modifie uniquement :

- `packages/ui/src/components/tool-call/renderers/task.tsx` ;
- `packages/ui/tests/browser/render-cost.test.ts` ;
- `packages/ui/tests/browser/fixtures/render-cost.tsx` ;
- ce rapport `dev-docs/issue-824-task-membership-fix.md`.

Aucun store/SDK/serveur/style, daemon, base utilisateur, profil, déploiement ou
restart modifié. Aucun commit/push, sous-agent ni installation de dépendances.

## Cause et correction

L'index incrémental inférait les changements de membership depuis les nombres de
messages/parts et l'identité du message de queue. Une relecture autoritaire peut
conserver toutes ces propriétés et supprimer, remplacer, réordonner ou changer le
type d'une part. Les shells supprimés se démontaient, mais `childToolKeys` et le
compteur/troncature gardaient des clés fantômes. Un ajout retrouvant l'ancienne
cardinalité restait invisible.

Le renderer réutilise maintenant son **scanner structurel borné existant** au point
de révision de session. Il ne compare ni copie les payloads/output : seuls les IDs
et le type de part déterminent les clés. On supprime les heuristiques de counts/tail
plutôt que d'ajouter un autre cache ou une politique de refresh. La liste précédente
est rendue telle quelle quand ses clés ordonnées sont identiques.

Le scan reste limité à **10 000 unités message/part** et s'arrête une fois trouvées
201 étapes ; seules les **200 dernières** s'affichent. Les constantes et le budget
du scanner restent inchangés. Le coût des IDs/type est payé à chaque révision,
même si le texte seul change : c'est le compromis explicite pour reconnaître tout
remplacement autoritaire, sans observer/comparer les gros payloads. Aucun gain CPU
nouveau ni coût maximal de 10 000 IDs en production n'est revendiqué ici.

`For` remplace `Index` sur les clés tool : une part retenue suit son identité quand
une suppression ou un réordonnancement change sa position. Une identité nouvelle
reçoit une shell/disclosure neuve. Les getters réactifs et le hash Markdown de la
correction précédente restent inchangés. Une lecture pendante conserve la liste
résidente ; le retour autoritaire, une page vide et le changement de child-session
continuent à la réconcilier. Le recalcul remet aussi la troncature à jour après shrink.

Delta produit relatif au renderer **déjà intégré avant cette tâche**, préimage
conservée dans le temp : **+12/-90 lignes**. Ce n'est pas un delta contre HEAD, qui
ne contient pas encore les correctifs mission. `task.tsx` reste **569 lignes**, au-
dessus du seuil d'avertissement ~500 ; aucun refactor de taille indépendant.

## Preuves exécutées

Node `v25.2.1`, Windows, Chromium Playwright `153.0.8010.12` ; vrais composants
Solid, stores et `loadMessages(..., { force: true })`, native/API réponses privées,
réseau hors loopback bloqué. Le message natif `child-message` reste le même ; le
fixture remplace sa liste de parts, pas le composant ni l'index.

Les cinq nouvelles assertions rouges causales, sans seuil timing :

1. `2 -> 1 -> 2` en gardant step-0 : counter reste `2 steps` au lieu de `1 steps` ;
2. même scénario en gardant step-1 (suppression en tête) : même counter faux ;
3. remplacement/réordre `[step-0, step-1] -> [step-2, step-0]` à cardinalité égale :
   nouvelle step-2 absente ;
4. changement tool -> text avec ID inchangé : counter reste à 2 au lieu de 1 ;
5. shrink de 201 à 199 parts : counter reste `200+ steps` au lieu de `199 steps`.

Sur correction, tous passent. Les deux premiers vérifient également l'arrivée
exactement une fois de la nouvelle step-2, puis l'identité shell/scroller, disclosure
ouverte et scrollTop 240 de l'étape retenue. Le troisième vérifie ordre DOM exact et
shell retained. Le cinquième vérifie 200 shells initiales, 199 ensuite et disparition
du diagnostic de troncature.

Gate final : 13 render-cost + 46 session-rendering + 6 task-copy + 3 tool-images =
**68 scénarios distincts**, ~176 s, exit 0 naturel, aucun failure/skip. Le contrôle
perf réel compte, pour chacun de dix deltas, **80 clones, 0 added, 0 removed** ; une
assertion explicite interdit maintenant les remounts dans ce sample instrumenté.
Ces compteurs sont distincts des A/B CPU antérieurs, qui restent dans leurs rapports
et ne sont pas recyclés comme mesures de ce patch.

`npm run typecheck --workspace @codenomad/ui` passe sur dernier patch.
`git diff --check` ciblé passe (avertissement LF/CRLF seulement).
Les SHA des trois exécutables de livraison sont identiques avant/après la séquence
rouge/verte. Cela qualifie la stabilité de ce lot, pas une composition entière
immutable de tous les travaux de mission.

## Artefacts et replay

Sous `C:/Users/Admin/AppData/Local/Temp/opencode/` :
`issue-824-membership-c5bca1d90b4a4564bd4c7f695b6381bd/` contient :

- `task-before.tsx` : préimage exacte avant correction M1 ;
- `red.log` : 5 échecs d'assertion attendus, exit 1, naturel ;
  SHA256 `db9316eb888984364cbdd59d2fac8fac74600ed9e5e779f9c86b33869b1fc51a` ;
- `green.log` : 68 passes, exit 0, naturel ;
  SHA256 `e4f5a996b9b576703888b353e14c02940b4dd72d0fe3e056cc54b96fcffe1849` ;
- `result.json` : statuts enfants + empreintes avant/après, `changed: []`.

SHA256 produit livré :
`f07ce171a6b1d3394ce94be496b0abd67f8bc0bb48e946eb9173a681c844f401`.
SHA256 test : `93d9e95988b53eb1e3934ecd13f4e8d32e0eb797682a866db113797174be5075`.
SHA256 fixture : `0df543ea983c23e33a4957ed6732dc81a2e04cf5ede7d4f1281d6ee058360ebb`.

Depuis `packages/ui`, avec TEMP/TMP pointant vers le temp approuvé :

```powershell
$env:CODENOMAD_RENDER_TASK_BASELINE='<artefact>/task-before.tsx'
node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 --test-name-pattern='^authoritative task membership' tests/browser/render-cost.test.ts
Remove-Item Env:CODENOMAD_RENDER_TASK_BASELINE
node --unhandled-rejections=strict --import tsx --test --test-concurrency=1 tests/browser/render-cost.test.ts tests/browser/session-rendering.test.ts tests/browser/task-copy.test.ts tests/browser/tool-images.test.ts
```

Prochaine étape : re-review indépendante du finding M1, puis validation combinée
sur la composition figée. Pas de qualification desktop/Linux/macOS, daemon réel ou
disparition universelle des freezes revendiquée par ce lot.
