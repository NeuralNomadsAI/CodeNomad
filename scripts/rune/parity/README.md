# Parité du contrôle de fermeture

La scène `--gallery-window-close` assemble le composant partagé `window_control` et la surface du thème. Elle utilise les métriques calculées de `styles/components/window.css`, les palettes et le catalogue de textes Solid. Le contrôle reçoit une identité stable, un nom optionnel et son action de fermeture. Son icône Lucide est masquée dans l'arbre accessible.

Le runner charge le vrai `components/window-close-button.tsx`, ses fournisseurs Solid et `src/index.css`. Il vérifie l'empreinte de la fiche générée, capture les états repos, survol et focus clavier dans les deux palettes et vérifie trois activations (clic, Entrée, Espace). Le serveur Vite possède son cache via les fixtures navigateur partagées ; Chromium reste headless. Les routes API sont simulées et les scènes Rune isolées des hôtes et sessions.

Depuis la racine du worktree, avec les dépendances npm verrouillées du dépôt installées :

```powershell
node scripts/rune/component-inventory.mjs
node scripts/rune/generate-theme.mjs --check
cargo build --locked -p codenomad-rune-app --bin codenomad-rune --features test-support
node --import tsx --test packages/ui/tests/browser/rune-window-close.test.ts
node --import tsx scripts/rune/parity/window-close.mjs
node --import tsx scripts/rune/parity/window-close.mjs --binary C:/chemin/cache-cargo/debug/codenomad-rune.exe
node scripts/rune/parity/compare-window-close.mjs
```

Exécuter `cargo test -p codenomad-rune-app gallery::tests` dans le cache Cargo existant. Ce test passe par le véritable runtime Rune, son arbre d'accessibilité et ses entrées simulées. Entrée est traitée dans le contrôle partagé afin de reproduire l'activation HTML.

Les preuves sont produites sous `target/rune-parity/window-close/` : PNG, références d'accessibilité Solid, arbres Rune, mesures CSS, journaux et différences RGBA par pixel. Les six comparaisons Windows à échelle 1 passent avec les seuils explicites de `window-close-thresholds.json` : erreur de canal maximale 2/255, somme des erreurs maximales par pixel limitée à 39, au plus 34 pixels différents sur 576, et aucun écart hors du carré de l'icône. Ces bornes correspondent aux maxima observés d'anticrénelage ; les fonds et contours de focus correspondent exactement. Les contrôles négatifs effaçant l'icône ou décalant le rendu d'un pixel échouent pour chaque capture.

Les rôles, noms, descriptions et états de focus proviennent des véritables arbres Rune ; la référence Solid expose un seul bouton « Close ». La qualification complète dépend aussi des deux revues indépendantes et des cibles natives et WebAssembly. Les seuils raster ci-dessus qualifient Windows à échelle 1.
