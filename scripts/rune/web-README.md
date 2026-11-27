# Coquille web Rune

`packages/rune-app/fixtures/launcher-fixture.mjs --web-git-images` ouvre les différences SVG et AVIF d’un dépôt privé. Le banc vérifie les octets Git, les deux noms accessibles et les couleurs réellement peintes dans le canvas Chromium. Utiliser un bundle produit dédié via `RUNE_WEB_DIR`.

`packages/rune-app/fixtures/launcher-fixture.mjs --web-missions` vérifie le panneau Missions monté avec le bundle produit (`RUNE_WEB_DIR`), un serveur Rust privé et des réponses de page déterministes. Chromium charge le WASM via HTTP avec WebCrypto désactivée. La sonde vérifie la reprise après refus d’ordre, la fiche sélectionnée, la pagination du répertoire et des tâches, l’activité et les tâches à examiner dans l’arborescence accessible.

Compiler le même binaire `codenomad-rune` pour `wasm32-unknown-unknown`, puis empaqueter son fichier `.wasm` explicitement. Le cache Cargo reste celui du développeur. `bundle-web.mjs` utilise le contrat de `Rune/scripts/web-build.sh` : génération `wasm-bindgen --target web`, copie des snippets et des faces Inter complètes à côté de `app.js`.

```powershell
$env:CARGO_TARGET_DIR = '<chemin-absolu-vers-la-cible-Cargo-de-ce-chantier>'
$env:RUNE_WASM_BINDGEN = '<chemin-absolu-vers-wasm-bindgen.exe>'
cargo build --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune --features test-support
node scripts/rune/bundle-web.mjs --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/codenomad-rune.wasm" --test-support
```

Le CLI doit correspondre exactement à la version de `wasm-bindgen` dans `Cargo.lock`. Son installation appartient à la préparation de l'environnement. Les polices sont résolues par les métadonnées Cargo de la dépendance Git Rune. La sortie par défaut est `target/rune-web`, remplaçable seulement lorsqu'elle porte le manifeste de cet outil. Les fichiers statiques servent via l'option existante `codenomad-rs serve --ui-dir` du serveur isolé.

Le banc `packages/rune-app/fixtures/markdown-image-browser.mjs` vérifie le client d’images WASM sur deux origines loopback. Compiler `markdown-image-browser.rs` en `cdylib` avec `codenomad-client`, `wasm-bindgen` et `wasm-bindgen-futures` du verrou, puis empaqueter avec `wasm-bindgen --target web --out-name app`. Passer le dossier de sortie à `--bundle` et le navigateur à `--executable`.

Le scénario synthétique et son bundle demandent explicitement `test-support`. Pour empaqueter le produit, compiler sans cette feature puis appeler le bundler sans `--test-support`. Le manifeste conserve ce statut et la fixture synthétique exige le bundle de qualification.

Le parcours connecté utilise le bundle produit sous `target/rune-web-connected`, servi par le mode de qualification du vrai serveur Rust avec l'amont OpenCode simulé existant :

```powershell
$env:CARGO_PROFILE_RELEASE_OPT_LEVEL = 'z'
$env:CARGO_PROFILE_RELEASE_LTO = 'thin'
cargo +1.99.1 build --locked --release --target wasm32-unknown-unknown -p codenomad-rune-app
node scripts/rune/bundle-web.mjs --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/release/codenomad-rune.wasm" --out target/rune-web-connected
node packages/rune-app/fixtures/launcher-fixture.mjs --web
```

Ces réglages s'appliquent à cette commande Cargo et à son environnement ; pour compiler ensuite un binaire natif avec les réglages par défaut, retirer les deux variables `CARGO_PROFILE_RELEASE_*` ou ouvrir un autre terminal.

Cette fixture vérifie cookies, refus sans authentification, deux pages de sessions, conversation exacte, session vide et retour, EventSource et arrêt du serveur, sans création ni envoi. Les six contextes et preuves restent sous `target/rune-web-tests/launcher-*/`.

`node packages/rune-app/fixtures/launcher-fixture.mjs --web-file-wrap` utilise le même bundle produit et le serveur isolé. Chromium headless ouvre deux onglets indépendants de même origine, bascule le retour à la ligne dans l’un, vérifie le contrôle à la réouverture du lecteur dans l’autre, puis après rechargement. Le scénario vérifie aussi la propagation de la désactivation.

`node packages/rune-app/fixtures/launcher-fixture.mjs --web-keyboard-viewport` utilise le même bundle produit et le serveur isolé sur 320, 360 et 390 CSS px (petit côté) en portrait et en paysage (6 contextes émulateurs tactiles pilotés à la souris et à la molette) avec une permission active sur `ses_existing` et une question active sur `ses_another`. Chaque cas vérifie le masquage de la navigation Précédent/Suivant sur demande unique, une saisie partielle de motif ou de réponse, le retour en haut de la pile externe et la conservation d'un passage intermédiaire mesuré depuis le bord haut interne de la région de conversation (`<= 2 px`) après rétrécissement puis retour à la hauteur initiale, la conservation continue sans perte du focus `textarea` et du brouillon du composeur à chaque transition (et la visibilité d'une bande de l'éditeur sans intervention manuelle après rétrécissement et après retour à la taille initiale), ainsi que l’activation réelle dans la scène (sélecteur de modèle avant et après fermeture du dock, composeur, refus de permission / annulation de question jusqu’à la disparition des boutons et du texte de la demande) et le rendu canvas non rogné (contraste de texte et bords internes `surface-control`) des boutons d'interruption et du bouton Envoyer sous l’en-tête de session (sans poster de prompt dans ce mode de fixture). La matrice Chromium ne couvre ni la rotation dans un même contexte, ni un clavier sans interruption, ni le rétrécissement de `visualViewport` seul (`page.setViewportSize` simule la réduction de hauteur du viewport, distincte du traitement natif d'`interactive-widget=resizes-content` par un clavier mobile réel et d'un `visualViewport.offsetTop` non nul, tandis que les tests unitaires Rust couvrent la règle pure de calcul `platform::resolve_reference_viewport_height` et son emploi dans `interruption::SessionLayout`, la lecture navigateur `window.innerHeight` / `visualViewport.height` restant limitée à `wasm32` ; en amont Rune `bridge.js:605`, le relais `<textarea>` ne reporte pas `visualViewport.offsetTop`), ni le suivi du curseur interne multiligne, ni les champs d'interruption focalisés pendant un rétrécissement, ni les gestes tactiles réels ; les tests natifs couvrent ces cas et Android/ADB exerce Gboard.

Avec le même bundle produit et `RUNE_SERVER_EXE` pointant vers le serveur Rust compilé, le smoke d'intégration se rejoue en une commande :

```powershell
node packages/rune-app/fixtures/launcher-fixture.mjs --web-mobile
```

Il vérifie l'appairage HTTPS depuis une autre origine, les sessions du dossier et des worktrees liés sans recherche, la recherche hors page, le SSE et sa reprise après la coupure de l'amont puis après un vrai redémarrage du serveur Rust sur le même port. Le toucher au centre, l'IME injectée, le redimensionnement et la conservation du brouillon lors du redémarrage et du réappairage sont vérifiés. Le profil Chromium Android portrait couvre clair, sombre et DPR 1 ; le bouton « Messages précédents » est vérifié désactivé dans le miroir accessible pendant la reconnexion.

Le contrôle `--web-mobile --same-origin-pairing` ouvre les liens sans page référente ; son rapport distingue ce contrôle du parcours complet avec `Referer`.

`--web-mobile --history-return-only` isole le retour à une conversation déjà lue : la fixture retient le GET du rappel des envois, puis exige le texte du fil avant de libérer ce GET. Le rapport contient `transcriptWhileRecallHeld`.

`--web-mobile-more-actions` vérifie ce retour puis le menu du composeur sur un seul profil portrait clair : focus DOM après rappel et effacement sans retoucher le champ, annulation de l’effacement, sélection d’un fichier et mise en file effective pendant une réponse.

Rune [#1713](https://github.com/anomalyco/rune/issues/1713) suit le focus DOM à la souris ; [#1677](https://github.com/anomalyco/rune/issues/1677) suit la projection des rôles. Le banc relève les rôles projetés, et le test natif exige le menu et sa ligne désactivée.

`node packages/rune-app/fixtures/launcher-fixture.mjs --web-android` utilise Chrome et le clavier logiciel d'un émulateur Android jetable déjà démarré, avec `RUNE_ANDROID_ADB` (chemin absolu), `RUNE_ANDROID_ADB_PORT` (serveur ADB privé) et `RUNE_ANDROID_SERIAL` (unique `emulator-*`). Le parcours suit un lien d'appairage externe, ouvre la conversation, défile via un geste Android, injecte un texte par CDP puis l'envoie via l'interface. Le banc coupe l'amont SSE et redémarre le serveur Rust sans recharger le document. `android-proof.json` contient les temps au premier contenu, les intervalles rAF du geste et la PSS des processus Chrome. Le cache HTTP est désactivé et le certificat de fixture épinglé. La dictée, la composition propre à Gboard et TalkBack gardent leurs essais distincts.

Pour une comparaison, compiler le serveur Rust de ce checkout et le build Solid :

```powershell
cargo build --locked --manifest-path packages/server-rs/Cargo.toml
npm run build --workspace @codenomad/ui
```

Si la compilation utilise une cible Cargo dédiée, pointer `RUNE_SERVER_EXE` vers son `codenomad-rs`. Régler `RUNE_ANDROID_COMPARE=1` dans les deux modes et `RUNE_ANDROID_SOLID_DIR` sur `packages/ui/src/renderer/dist` (chemin absolu) uniquement pour Solid. Le comparatif avec Rust exige la correction du chantier serveur qui sert l'entrée et les ressources Vite Solid aux navigateurs appairés sur le listener HTTPS. Recompiler le serveur du checkout une fois cette correction intégrée.

Les délais de sélection et d'envoi démarrent au même toucher CDP, après résolution de la cible dans chaque client. Le lanceur garde la réservation ADB : il arrête Chrome et retire le reverse de l'essai même si le processus client est tué. `RUNE_ANDROID_CLIENT_BUDGET_MS` permet de raccourcir l'échéance pour vérifier ce nettoyage. `RUNE_ANDROID_TRACE=display` ajoute un deuxième geste pour mesurer les images présentées par Chrome ; `RUNE_ANDROID_TRACE=1` produit la trace détaillée et les compteurs Rune.

`RUNE_ANDROID_GPU_PROBE=only` s'arrête au lanceur et consigne la demande d'adaptateur de Rune, les appels témoins et la configuration Chrome. `RUNE_ANDROID_TS_SERVER=1`, en mode Solid, utilise le serveur TS compilé du checkout et un nom HTTPS de fixture résolu par Chrome pour comparer la reprise après redémarrage.

Le build WASM inclut le repli WebGL2 de Rune ; WebGPU conserve la priorité. Pour le qualifier, `RUNE_ANDROID_GPU_PROBE=webgl` exige la fin de la bascule vers WebGL2 et vérifie qu'il reste actif pendant la conversation et après la reprise.

`RUNE_ANDROID_SAMPLE=scroll` limite une répétition au premier historique et au geste. `RUNE_ANDROID_TRACE=stutter` ajoute les événements GPU/GC et marque les demandes WebGL2 de compilation et de liaison de shaders. Les sondes du lanceur enregistrent l'affichage initial séparément du résultat de la bascule.

Pour isoler le coût de la bascule avec le même WASM, la sonde du lanceur accepte `RUNE_ANDROID_BOOT_CONTROL=no-webgl` (refus du contexte WebGL2) ou `cpu-only` (aucune demande GPU). Elle relève la fin de la réponse WASM et les tâches longues avant le lanceur.

Les libellés de démarrage et d'erreur proviennent des dix catalogues générés. `?locale=he` sélectionne par exemple l'hébreu et la direction RTL ; la valeur par défaut est `fr`. Les couleurs, dimensions et polices du démarrage consomment le thème généré et `crates/rune-theme-codenomad/assets/web-shell.css`. Le zoom du navigateur reste disponible.

### Créer un lien sur l'hôte Rust

Depuis `packages/server-rs` sur l'hôte, remplacez l'origine par l'adresse HTTPS annoncée par le serveur. Les scripts utilisent les paramètres de l'installation locale ([installation Rust](../../packages/server-rs/install/README.md)). Ouvrez l'URL `url` de la réponse dans un autre onglet sur l'appareil.

```sh
bash install/linux/admin.sh POST /api/remote-control/pairings '{"origin":"https://code.example:47943"}'
```

```powershell
pwsh -File install/windows/admin.ps1 -Root $Root -Method POST -Path /api/remote-control/pairings -Body '{"origin":"https://code.example:47943"}'
```

Le runner complet crée un profil privé et un espace de travail vide, configure un exécutable OpenCode privé absent, démarre le vrai serveur Rust sur un port loopback éphémère, authentifie les seuls cookies de cette fixture et vérifie le HTML et le MIME/empreinte du module WASM. Il exécute ensuite le smoke et exige le marqueur de fermeture complète et le code de sortie zéro. Les données et preuves restent sous `target/rune-web-tests/trial-*`.

```powershell
$env:RUNE_SERVER_EXE = '<chemin-absolu-vers-codenomad-rs.exe>'
node scripts/rune/web-fixture.mjs
```

`bundle-manifest.json` recense les empreintes SHA-256 des fichiers publics et du module d'entrée, les versions des outils et les tailles brutes, gzip niveau 9 et Brotli qualité 5. Les totaux portent sur les fichiers publics empaquetés, hors manifeste. Un fichier compagnon `.br` est écrit à côté de chaque ressource plus petite en Brotli et répertorié séparément sous `compressed` / `compressedTotals` (avec son empreinte SHA-256 et sa taille) afin que l'hôte puisse le servir en `Content-Encoding: br` sans exposer le chemin `.br` dans la liste publique. Le profil du fichier WASM d'entrée détermine les optimisations présentes dans le bundle.

```text
node scripts/rune/web-smoke.mjs --url http://127.0.0.1:<port-fixture>/
```

Le smoke test attend un serveur de test loopback déjà démarré. Il ouvre exclusivement Chromium headless, impose la scène synthétique et bloque les requêtes API et les autres origines. Il collecte des captures claires et sombres, le miroir d'accessibilité DOM réel, la saisie multiligne, le dimensionnement du canvas et les mesures de chargement observées sur le navigateur de test. Les formats téléphone et tablette sont des émulations de viewport et de pointeur tactile. Les essais de clavier mobile, dictée, lecteur d'écran, consommation et performance soutenue attendent des appareils physiques. Le parcours connecté au serveur et à une fixture OpenCode possède sa qualification séparée.
