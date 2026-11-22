# Coquille web Rune

Compiler le même binaire `codenomad-rune` pour `wasm32-unknown-unknown`, puis empaqueter son fichier `.wasm` explicitement. Le cache Cargo reste celui du développeur. `bundle-web.mjs` utilise le contrat de `Rune/scripts/web-build.sh` : génération `wasm-bindgen --target web`, copie des snippets et des faces Inter complètes à côté de `app.js`.

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
$env:RUNE_WASM_BINDGEN = '<chemin-absolu-vers-wasm-bindgen.exe>'
cargo build --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune --features test-support
node scripts/rune/bundle-web.mjs --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/codenomad-rune.wasm" --test-support
```

Le CLI doit correspondre exactement à la version de `wasm-bindgen` dans `Cargo.lock`. Son installation appartient à la préparation de l'environnement. Les polices sont résolues par les métadonnées Cargo de la dépendance Git Rune. La sortie par défaut est `target/rune-web`, remplaçable seulement lorsqu'elle porte le manifeste de cet outil. Les fichiers statiques servent via l'option existante `codenomad-rs serve --ui-dir` du serveur isolé.

Le scénario synthétique et son bundle demandent explicitement `test-support`. Pour empaqueter le produit, compiler sans cette feature puis appeler le bundler sans `--test-support`. Le manifeste conserve ce statut et la fixture synthétique exige le bundle de qualification.

Le parcours connecté utilise le bundle produit sous `target/rune-web-connected`, servi par le mode de qualification du vrai serveur Rust avec l'amont OpenCode simulé existant :

```powershell
cargo build --locked --target wasm32-unknown-unknown -p codenomad-rune-app
node scripts/rune/bundle-web.mjs --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/codenomad-rune.wasm" --out target/rune-web-connected
node packages/rune-app/fixtures/launcher-fixture.mjs --web
```

Cette fixture vérifie cookies, refus sans authentification, deux pages de sessions, conversation exacte, session vide et retour, EventSource et arrêt du serveur, sans création ni envoi. Les six contextes et preuves restent sous `target/rune-web-tests/launcher-*/`.

Les libellés de démarrage et d'erreur proviennent des dix catalogues générés. `?locale=he` sélectionne par exemple l'hébreu et la direction RTL ; la valeur par défaut est `fr`. Les couleurs, dimensions et polices du démarrage consomment le thème généré et `crates/rune-theme-codenomad/assets/web-shell.css`. Le zoom du navigateur reste disponible.

Le runner complet crée un profil privé et un espace de travail vide, configure un exécutable OpenCode privé absent, démarre le vrai serveur Rust sur un port loopback éphémère, authentifie les seuls cookies de cette fixture et vérifie le HTML et le MIME/empreinte du module WASM. Il exécute ensuite le smoke et exige le marqueur de fermeture complète et le code de sortie zéro. Les données et preuves restent sous `target/rune-web-tests/trial-*`.

```powershell
$env:RUNE_SERVER_EXE = '<chemin-absolu-vers-codenomad-rs.exe>'
node scripts/rune/web-fixture.mjs
```

`bundle-manifest.json` recense les empreintes SHA-256 des fichiers et du module d'entrée, les versions des outils et les tailles brutes, gzip niveau 9 et Brotli qualité 5. Les totaux portent sur les fichiers empaquetés, hors manifeste. Les tailles compressées sont mesurées ; leur service avec négociation HTTP dépend de l'hôte. Le profil du fichier WASM d'entrée détermine les optimisations présentes dans le bundle.

```text
node scripts/rune/web-smoke.mjs --url http://127.0.0.1:<port-fixture>/
```

Le smoke test attend un serveur de test loopback déjà démarré. Il ouvre exclusivement Chromium headless, impose la scène synthétique et bloque les requêtes API et les autres origines. Il collecte des captures claires et sombres, le miroir d'accessibilité DOM réel, la saisie multiligne, le dimensionnement du canvas et les mesures de chargement observées sur le navigateur de test. Les formats téléphone et tablette sont des émulations de viewport et de pointeur tactile. Les essais de clavier mobile, dictée, lecteur d'écran, consommation et performance soutenue attendent des appareils physiques. Le parcours connecté au serveur et à une fixture OpenCode possède sa qualification séparée.
