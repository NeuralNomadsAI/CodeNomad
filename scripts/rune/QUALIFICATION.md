# Qualification Rune sans fenêtre

Le workflow `.github/workflows/rune-native.yml` prépare et contrôle la révision Rune, les sources générées et l'inventaire, puis exécute les tests Rust et le contrôle de styles sous Windows, macOS et Linux. `CARGO_TARGET_DIR` désigne explicitement le cache Cargo ; les captures et arbres restent sous `target/rune-evidence/<OS>`. Chaque artefact est nommé `rune-native-<OS>-<architecture>`.

Pour inspecter et agir sur le vrai runtime sans fenêtre, après compilation :

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
node scripts/rune/prepare.mjs --check
node scripts/rune/headless.mjs --binary "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe"
```

Le scénario `headless-interaction.json` utilise la scène synthétique de 10 000 messages, les entrées simulées Rune, un collage multiligne Unicode, un défilement, le bouton de retour en bas et le focus du composeur. Le validateur lit `accessibility` dans le vrai `--tree`, vérifie les rôles, noms, valeur et états attendus et conserve les arbres complets. Le défilement est vérifié par l'offset et le maximum accessibles, puis par l'intersection du rectangle présenté du dernier message avec le clip de l'historique et le viewport ; l'overscan peut conserver des lignes hors clip dans l'arbre monté. Les tests Rust du runtime vérifient la virtualisation bornée et la conservation de la position pendant un delta. Les captures utilisent les demandes `--theme light` et `--theme dark` du moteur offscreen ; le validateur exige aussi deux couleurs de canvas distinctes.

Le lanceur retire les variables `RUNE_*` héritées et impose la scène synthétique ; les essais utilisent `trial-rune-headless`. Les interactions restent internes au runtime, y compris le collage simulé. Le script reçoit un chemin absolu de binaire compilé et effectue uniquement des lancements avec `--tree` et `--snap`.

## Parité par composant

Les composants Solid et Rune demandent des paires de captures exécutées à géométrie identique, dans chaque palette, avec références d'accessibilité et interactions dédiées. Le statut de parité reste à qualifier pour les composants de l'inventaire.

`qualify-pixels.mjs` compare deux vraies captures fournies par leur fixture. Son seuil est un argument obligatoire, choisi lors de la qualification du composant. Le rapport décrit la proportion de pixels RGBA différents ; les dimensions doivent correspondre. Exemple de commande à compléter avec le seuil revu du composant :

```text
node scripts/rune/qualify-pixels.mjs --component <identité> --theme light --solid <capture-Solid.png> --rune <capture-Rune.png> --max-diff-ratio <seuil-revu> --report <rapport.json>
```

La matrice CI doit être exécutée sur ses trois runners pour qualifier les dépendances natives, le GPU offscreen et les différences de rendu propres aux plateformes. Les arbres et images produits servent de preuves à cette qualification.

## Latence face à la TUI

Le banc `scripts/perf/bench.mjs` définit le protocole : marqueurs `MARKER` de `scripts/perf/lib.mjs`, dates de réception et d'affichage, touches pendant les flux concurrents, contrôle des marqueurs attendus et mesures de p95. `perf-check.mjs` exige trois tours distincts aux niveaux 8 et 32 ; `budget-report.mjs` rapporte les ratios CodeNomad/TUI avec le plancher commun de 50 ms et les budgets existants.

Le raccord Rune à ce collecteur reste à qualifier : il doit observer les marqueurs effectivement affichés et les touches traitées pendant un flux réel, sur une même horloge de mesure, puis produire les mêmes échantillons que le pilote TUI. Les durées du moteur offscreen à horloge virtuelle servent à analyser son travail de rendu. La qualification de latence attend le raccord et son exécution face à la TUI ; les rapports de cette catégorie restent à produire.
