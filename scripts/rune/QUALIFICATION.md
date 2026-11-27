# Qualification Rune sans fenêtre

Le workflow `.github/workflows/rune-native.yml` utilise les dépendances Git Rune épinglées par Cargo, contrôle les sources générées et l'inventaire, puis exécute les tests Rust et le contrôle de styles sous Windows, macOS et Linux. `CARGO_TARGET_DIR` désigne explicitement le cache Cargo ; les captures et arbres restent sous `target/rune-evidence/<OS>`. Chaque artefact est nommé `rune-native-<OS>-<architecture>`. Les journaux d'exécution restent dans ces sorties ignorées ou les artefacts CI.

Pour inspecter et agir sur le vrai runtime sans fenêtre, après compilation :

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
cargo build --locked -p codenomad-host-process --bin codenomad-fixture-job
cargo build --locked -p codenomad-rune-app --bin codenomad-rune --features test-support
node scripts/rune/headless.mjs --binary "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe"
```

Le scénario `headless-interaction.json` utilise la scène synthétique de 10 000 messages, les entrées simulées Rune, un collage multiligne Unicode, un défilement, le bouton de retour en bas et le focus du composeur. Le validateur lit `accessibility` dans le vrai `--tree`, vérifie les rôles, noms, valeur et états attendus et conserve les arbres complets. Le défilement est vérifié par l'offset et le maximum accessibles, puis par l'intersection du rectangle présenté du dernier message avec le clip de l'historique et le viewport ; l'overscan peut conserver des lignes hors clip dans l'arbre monté. Les tests Rust du runtime vérifient la virtualisation bornée et la conservation de la position pendant un delta. Les captures utilisent les demandes `--theme light` et `--theme dark` du moteur offscreen ; le validateur exige aussi deux couleurs de canvas distinctes.

Le lanceur retire les variables `RUNE_*` héritées et impose la scène synthétique ; les essais utilisent `trial-rune-headless`. Les interactions restent internes au runtime, y compris le collage simulé. Le script reçoit un chemin absolu de binaire compilé et effectue uniquement des lancements avec `--tree` et `--snap`.

La CI restaure les téléchargements Cargo vérifiés par l'action partagée, puis reconstruit ses artefacts. Elle compile aussi `packages/server-rs` et exerce `launcher-fixture.mjs --workspace-claims`, `launcher-fixture.mjs --restore-state`, `launcher-fixture.mjs --files-state` et `recovery-fixture.mjs` sur les trois systèmes. Ces essais relient le vrai client et le vrai serveur Rust à un OpenCode simulé isolé ; les preuves JSON des profils possédés sont jointes aux artefacts du job.

Le mode `--files-state` ouvre un projet privé et sa session synthétique existante. Des ACK JSON synchronisent les créations, renommages et suppressions du runner avec les observations du contrôleur via les watches et le SSE réels. Repli, masquage et retour d'onglet vérifient la rétention de sélection et d'expansion ; le scénario exige zéro prompt, zéro session native créée et la libération des records. Il qualifie le modèle et ses hooks, avec un parcours d'ouverture réel ; la vue Files, les requêtes masquées et l'annulation de corps HTTP ont leurs essais séparés.

La feature `test-support` active les scènes, la galerie et les sondes de qualification. Avant ces builds, `check-production.mjs` vérifie les artefacts par défaut : refus des arguments de qualification, absence de marqueurs de sondes dans les binaires natif et WASM, et fonctionnement de l'inspection Rune sur le lanceur du produit.

Le binaire séparé `web-focus-fixture` exige `test-support` et importe le vrai Close applicatif ainsi que le menu partagé `action_menu`. `tests/web_focus_probe.rs` compare le Runtime public natif au mode commun ; `parity/web-focus.mjs` s'exécute manuellement sur ce bundle WASM séparé et son miroir DOM sous Chromium headless en clair/sombre, sur un hôte loopback possédé. Les compteurs séparent action unique, défaut explicite, champ submit, focus, modal, menu et Tx ; les phases Espace et la répétition enregistrent des constantes de référence Solid codées en dur pour les écarts connus. Le vrai scope applicatif et le rendu racine produit sont qualifiés par `launcher::view::tests`.

```powershell
cargo +1.99.1 test --locked -p rune-theme-codenomad --test web_focus_probe -- --nocapture
cargo +1.99.1 build --locked -p rune-theme-codenomad --example web-focus-fixture --features test-support --target wasm32-unknown-unknown
node scripts/rune/parity/web-focus.mjs --wasm C:\cn-cargo\files\wasm32-unknown-unknown\debug\examples\web-focus-fixture.wasm --bindgen <chemin-absolu-wasm-bindgen.exe> --rune <checkout-rune-verrouillé>\crates\rune --executable <chemin-absolu-chromium.exe>
```

Le contrat SSE Préférences/Git s'exécute dans Chromium depuis la sonde WASM du client. Avec `wasm-bindgen` à la version de `Cargo.lock` et Chromium Playwright installé :

```sh
cargo build --locked -p codenomad-client --example browser-preference-events --target wasm32-unknown-unknown
wasm-bindgen --target web --out-name probe --out-dir "$CARGO_TARGET_DIR/browser-sse/probe" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/examples/browser-preference-events.wasm"
node packages/rune-app/fixtures/browser-preference-events.mjs "$CARGO_TARGET_DIR/browser-sse/probe"
```

La sonde notifications remplace `window.Notification` par un enregistreur dans Chromium headless. Elle vérifie la demande d’autorisation depuis un clic, l’envoi après accord et le retrait du gestionnaire après révocation, sans notification système :

```sh
cargo build --locked -p codenomad-rune-app --features test-support --example browser-notifications --target wasm32-unknown-unknown
wasm-bindgen --target web --out-name probe --out-dir "$CARGO_TARGET_DIR/browser-notifications" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/examples/browser_notifications.wasm"
node packages/rune-app/fixtures/browser-notifications.mjs "$CARGO_TARGET_DIR/browser-notifications"
```

Les tests Windows vérifient l'ordre natif de l'index, les curseurs et les sauts par fenêtre `around`. La sonde Chromium rejoue les mêmes lectures avec le cookie de la même origine, y compris le saut résident sans requête :

```sh
cargo test --locked -p codenomad-client timeline::tests
cargo build --locked -p codenomad-client --example browser-outline --target wasm32-unknown-unknown
wasm-bindgen --target web --out-name probe --out-dir "$CARGO_TARGET_DIR/browser-outline" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/examples/browser-outline.wasm"
node packages/rune-app/fixtures/browser-outline.mjs "$CARGO_TARGET_DIR/browser-outline"
```

La galerie `history-rail` monte le composant Rune sur 200 000 repères sans serveur. Le test Windows vérifie l'étendue en haut et en bas, le nombre de repères montés, le clavier et le seuil de largeur. Chromium vérifie le miroir accessible, le clic, le clavier, le saut à un repère hors écran et la disparition sous 420 px, en clair et en sombre.

```sh
cargo test --locked -p rune-theme-codenomad --example history-rail
cargo build --locked -p rune-theme-codenomad --example history-rail --target wasm32-unknown-unknown
wasm-bindgen --target web --out-name rail --out-dir "$CARGO_TARGET_DIR/browser-rail" "$CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/examples/history-rail.wasm"
node packages/rune-app/fixtures/history-rail-web.mjs "$CARGO_TARGET_DIR/browser-rail"
```

Le raccord conversation est couvert par `cargo test --locked -p codenomad-rune-app timeline::` et, avec le bundle produit WASM et le serveur Rust de qualification, par `node packages/rune-app/fixtures/launcher-fixture.mjs --web-timeline`. Le banc vérifie le survol hors fenêtre sans page de transcript, le passage du pointeur à l’infobulle, le focus et la fermeture, puis un saut `around` et un saut résident sans requête.

`node packages/rune-app/fixtures/launcher-fixture.mjs --web-touch-history` envoie le toucher, le glissement et le relâchement par le canal CDP tactile. Le banc retient la réponse du lecteur pendant le retour élastique et vérifie un seul curseur `before` ainsi que la disparition du statut après admission.

La recherche utilise le même banc Rust, via `node packages/rune-app/fixtures/launcher-fixture.mjs --web-history-search` avec les routes `query` et `ranked`. Le scénario vérifie le focus pendant le glissement, l'ordre de Maj+Tab, le seuil de requête, un résultat résident sans fenêtre et l'ouverture d'une autre session par une fenêtre `around` après lecture unitaire. Sur mobile en paysage, il réduit la hauteur et fait défiler le corps jusqu'à une continuation classée sans déplacer la barre. Les tests `codenomad-client search::tests` couvrent aussi le redémarrage classé.

`node packages/rune-app/fixtures/launcher-fixture.mjs --web-outline-restore` vérifie en Chromium un rechargement réel avec le repère restauré avant la réponse du broker, la réutilisation de la plage inchangée et le retour à une lecture à froid quand le cache est corrompu. Les deux rechargements conservent le brouillon.

`node packages/rune-app/fixtures/transcript-images-browser.mjs <bundle-test-support> <sortie>` vérifie les pièces jointes et l’agrandissement au clavier, une image d’outil AVIF animée, une référence authentifiée, et deux chargements externes avec et sans CORS. Le fichier `animated-32.avif.b64` contient deux images de `ffmpeg -f lavfi -i testsrc2=size=32x32:rate=2 -frames:v 2 -c:v libaom-av1 animated.avif`.

Le banc Code Mode vérifie quatre écritures de 70 Kio, la relecture après une trame hors borne et l’actualisation du fil enfant sur la connexion d’origine :

```powershell
cargo build --locked -p codenomad-client --example tool-progress-sse
cargo build --locked -p codenomad-client --example tool-progress-sse --target wasm32-unknown-unknown
wasm-bindgen --target web --out-name probe --out-dir "$env:CARGO_TARGET_DIR/tool-progress-sse" "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/examples/tool-progress-sse.wasm"
node packages/rune-app/fixtures/tool-progress-sse.mjs "$env:CARGO_TARGET_DIR/debug/examples/tool-progress-sse.exe" "$env:CARGO_TARGET_DIR/tool-progress-sse"
```

`pending-live-fixture.mjs --opencode <exécutable-absolu>` utilise un OpenCode privé, le serveur Rust et Rune sans fenêtre. Il vérifie trois décisions d’autorisation dans le fil et deux règlements de Forms dans le dock, et écrit ses preuves dans son profil jetable `scripts/perf/run/trial-rune-live-*`.

## Parité par composant

Les composants Solid et Rune demandent des paires de captures exécutées à géométrie identique, dans chaque palette, avec références d'accessibilité et interactions dédiées. Le statut de parité reste à qualifier pour les composants de l'inventaire.

`qualify-pixels.mjs` compare deux vraies captures fournies par leur fixture. Son seuil est un argument obligatoire, choisi lors de la qualification du composant. Le rapport décrit la proportion de pixels RGBA différents ; les dimensions doivent correspondre. Exemple de commande à compléter avec le seuil revu du composant :

```text
node scripts/rune/qualify-pixels.mjs --component <identité> --theme light --solid <capture-Solid.png> --rune <capture-Rune.png> --max-diff-ratio <seuil-revu> --report <rapport.json>
```

La matrice CI doit être exécutée sur ses trois runners pour qualifier les dépendances natives, le GPU offscreen et les différences de rendu propres aux plateformes. Les arbres et images produits servent de preuves à cette qualification.

La galerie `workspace-tree-row` produit vingt scènes natives clair/sombre, LTR/RTL sur chaque OS. Windows monte aussi le vrai WorkspaceTree Solid et applique `workspace-tree-row-thresholds.json` : budgets régionaux revus pour échelle 1 et largeur 360, avec 208 mutations négatives exigées. `compare-workspace-tree-row.mjs` vérifie la géométrie, l'exhaustivité des cas, chaque pixel et les empreintes avant de comparer. Les actions fournies par la galerie et l'image figée d'activité gardent ce périmètre ; l'arbre complet, les autres dimensions, les animations et le miroir DOM demandent leurs qualifications.

## Latence face à la TUI

Le banc `scripts/perf/bench.mjs` définit le protocole : marqueurs `MARKER` de `scripts/perf/lib.mjs`, dates de réception et d'affichage, touches pendant les flux concurrents, contrôle des marqueurs attendus et mesures de p95. `perf-check.mjs` exige trois tours distincts aux niveaux 8 et 32 ; `budget-report.mjs` rapporte les ratios CodeNomad/TUI avec le plancher commun de 50 ms et les budgets existants.

L'adaptateur `scripts/perf/rune.mjs` pilote la sonde `tests/probes/latency.rs`, compilée avec `test-support`. Elle utilise le vrai état et le rendu CPU Rune, les clips et positions des glyphes, puis vérifie l'encre contre un tampon sans glyphes avant horodatage monotone. La mesure inclut cette validation et porte sur le tampon CPU. Le pilote corrèle les horloges et réutilise les mêmes marqueurs, touches et budgets que la TUI.

Un préflight L1 d'un tour qualifie le parcours. L'admission exige des builds optimisés, trois tours L8/L32 et le contrôle des budgets, avec le vrai OpenCode privé et son fournisseur local. Le plugin d'historique utilise l'installateur du produit dans le seul profil du banc.

Le banc atteste via l'OS le propriétaire du socket d'écoute avant l'ouverture et le pair TCP établi après l'ouverture de chaque nouvelle connexion, avant d'envoyer le premier `/api/info` de contrôle d'identité puis toute requête authentifiée. Les requêtes JSON, le flux SSE du pilote (`daemon.send`), le serveur Rust et la TUI passent par ce pool ou relais loopback attesté, sans proxy ni redirection ; la TUI démarre dans un environnement purgé des variables proxy, sous Job Object Windows avec héritage ConPTY (`codenomad-fixture-job --inherit-console`) ou sous le superviseur POSIX dédié en même groupe (`native-fixture-posix-supervisor.mjs --same-group`). Construire `codenomad-fixture-job` ou fournir son chemin absolu dans `CODENOMAD_FIXTURE_JOB_EXE` (requis sous Windows ; un superviseur POSIX prend le relais pour les autres fixtures si le binaire n'est pas construit).

```powershell
node scripts/perf/bench.mjs $env:OPENCODE_TEST_BINARY --mode latency --rune-only --rune $env:RUNE_CLIENT_EXE --rune-server $env:RUNE_SERVER_EXE --rounds 3 --levels 8,32
node scripts/perf/perf-check.mjs <results> --client rune-cpu --latency-only --summary <rapport>
```
