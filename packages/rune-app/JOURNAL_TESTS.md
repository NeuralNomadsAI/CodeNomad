# Journal des tests Rune

## Périmètre

Worktree : `D:/CodeNomad/.codenomad/worktrees/rune-foundations-20261122`.

L'application est dans `packages/rune-app`, le client partagé dans `crates/codenomad-client` et le thème/catalogue dans `crates/rune-theme-codenomad`. Les sorties de test restent ignorées par Git : `target/`, `packages/rune-app/fixture-profile/` et les journaux `.tmp-rune-*.log`.

Les essais automatiques utilisent des profils `trial-*`, des projets synthétiques, des ports éphémères et des processus possédés par la fixture. Les interactions sont simulées dans le runtime ou dans Chromium headless. La copie testée du presse-papiers est en mémoire.

## Vérifications du portage

| Cas | Environnement | Résultat et preuve |
|---|---|---|
| Client HTTP asynchrone, bornes de réponse, SSE Unicode/CRLF, annulation, canaux abandonnés, chemins Windows/POSIX, scopes de session | Réseau loopback jetable et tests de contrats | 15 tests réussis ; `.tmp-rune-workspace-tests.log` |
| Confinement des processus et arrêt des descendants possédés | Processus de fixture séparés | 2 tests réussis ; même journal |
| Chat, multiligne, deux envois distincts, code sélectionnable, 10 000 messages, outils, questions, panne de bootstrap, petite hauteur et RTL | Véritable runtime Rune sans fenêtre | 27 tests réussis et 1 test réel séparé ignoré par défaut ; `.tmp-rune-domain-tests-final.log` |
| Thème, catalogues, géométrie, apparence, bornes du panneau de demandes | Rust et sources CSS Solid | 7 tests et 2 exemples compile-fail réussis ; même journal |
| Frontière des styles : méthodes visuelles, alias, macros, configurations, mutations imbriquées et chemin des sondes conditionné | Analyse AST des sources et révision Rune épinglée | 5 tests réussis ; `.tmp-rune-synced-workspace.log` |
| Démarrage normal de Rune, bootstrap, inventaire de projets, libération de l'état et jonction des workers d'arrêt | Véritable serveur Rust partagé, profil neuf, exécutable OpenCode privé absent | Réussi ; `.tmp-rune-owned-startup.log` |
| Arrêt confirmé et nouvelle génération du serveur, consommation unique du bootstrap | Véritable serveur Rust partagé et test explicitement sélectionné | 1 test réussi ; `.tmp-rune-host-shared.log` |
| Défilement, retour en bas, collage Unicode, focus, accessibilité et contraste des glyphes en clair/sombre | Quatre exécutions du binaire natif avec `--tree` et `--snap` | Réussi ; `target/rune-headless/qualification.json` |
| Pagination, page en erreur, résultat périmé, coupure SSE, rejeu, changement de génération et ancre absente | Véritable serveur Rust partagé + OpenCode simulé + proxy de panne propre au test | 606 lignes finales, saut d'ancre maximal 0 point ; `.tmp-rune-recovery-shared.log` |
| Dossier, catalogue paginé, reprise, création, brouillon, deux envois et outils | Véritable serveur Rust partagé + OpenCode simulé | Réussi ; `.tmp-rune-launcher-tools-shared.log` |
| Modèle/variante, question typée et annulation, trois décisions et motifs, refus périmé/étranger, erreur puis nouvel essai, arrêt pendant un chargement | Véritable serveur Rust partagé + OpenCode simulé | Réussi ; `.tmp-rune-controls-shared.log` |
| Deux réponses distinctes et ping/pong | Fixture HTTP/SSE directe | Réussi ; `.tmp-rune-direct.log` |
| Inventaire AST, génération déterministe, invariance des métriques malgré les fontes, fins de ligne LF/CRLF et shell web | Tests Node et générateurs | 7 tests réussis ; `.tmp-rune-node-tests.log` |
| Même client, même état et mêmes écrans compilés pour WebAssembly | `wasm32-unknown-unknown` | Compilation réussie ; `.tmp-rune-app-wasm-build.log` |
| Organisation par domaine et exclusion des sondes du produit | Builds natif et WASM sans feature, puis inspection réelle du lanceur | Réussi ; `.tmp-rune-product-native.log`, `.tmp-rune-product-wasm.log` et `target/rune-production/production-report.json` |
| Retrait d'une permission ou question pendant la saisie | Runtime Rune, snapshot autoritaire, édition en attente et réconciliation du focus | 2 tests réussis ; `.tmp-rune-pending-edit.log` |

La réorganisation conserve les scénarios : reprise de 606 lignes avec saut d'ancre nul (`.tmp-rune-domain-recovery.log`), deux envois avec outils (`.tmp-rune-domain-launcher.log`), commandes d'agent (`.tmp-rune-domain-controls.log`), quatre captures natives (`target/rune-domain-headless/qualification.json`) et six contextes web (`target/rune-web-tests/trial-lmH7lV/proof.json`). Le contrôle de styles recompilé passe (`.tmp-rune-domain-policy.log`).

L'audit lexical relu relève 48 appels `unwrap`/`expect` produit, 125 dans les tests, 103 dans les sondes et 2 au build. Les invariants concernent surtout les données générées, les fenêtres bornées et l'état UI. Les échecs de création d'exécuteur, de timers navigateur et l'empoisonnement de mutex restent à durcir. Le registre et ses empreintes sont dans `target/panic-audit.json`, avec analyse dans `target/panic-audit.md`. Les deux ordres de retrait pendant la saisie testés réussissent.

Le serveur partagé est construit depuis ce worktree et son intégration Rust. Le cache de compilation réutilisé peut se trouver sous un autre worktree ; son emplacement constitue un cache, tandis que le manifeste passé à Cargo détermine les sources.

## Parité du contrôle de fermeture

La fixture charge le véritable composant Solid, ses fournisseurs et ses styles. Le composant Rune possède une scène de galerie et utilise les métriques générées de ces styles.

Six paires de captures Windows à l'échelle 1 couvrent clair/sombre et repos/survol/focus. La qualification mesurée admet au plus 2/255 d'écart de canal, 39 d'écart cumulé et 34 pixels différents sur 576 ; les pixels hors icône correspondent exactement. Les mutations négatives suppriment l'icône ou la déplacent d'un pixel et sont rejetées.

Les contrôles vérifient aussi rôle, nom, description, dimensions, focus et activations clic/Entrée/Espace. Les preuves sont sous `target/rune-parity/window-close/`. La commande de comparaison et son seuil explicite sont dans `scripts/rune/parity/`. Les images des autres systèmes et échelles demandent leur qualification propre.

## Web et mobile

Le bundle utilise le même binaire WASM. Il contient la colle JavaScript et les snippets produits par la version de `wasm-bindgen` du verrou Cargo, les polices et un démarrage traduit depuis les dix catalogues. Le manifeste recense les empreintes et les poids bruts, gzip et Brotli. Deux empaquetages du même module produisent un manifeste identique.

La fixture `scripts/rune/web-fixture.mjs` utilise le véritable `codenomad-rs serve --ui-dir`, authentifie son contexte privé et vérifie le HTML, le MIME `application/wasm` et l'empreinte du module servi. Six contextes Chromium headless couvrent bureau/tablette/téléphone et clair/sombre : dimensionnement, arbre DOM accessible, saisie multiligne et captures. Dix-huit zones de texte atteignent le seuil de contraste de 4,5 avec leurs pixels d'encre ; les dix-huit contrôles négatifs qui effacent ces pixels sont rejetés. La scène synthétique bloque les requêtes API et externes. L'arrêt exige le marqueur de fermeture complète et une sortie zéro.

Les preuves sont sous `target/rune-web-tests/trial-*/`, avec `proof.json`, `browser/smoke-report.json` et les captures. Les mesures locales de chargement et les poids correspondent au profil de compilation indiqué dans le manifeste. Le rapport de risques et les essais sur appareil physique sont décrits dans `dev-docs/RUNE_WEB.md`.

## Commandes reproductibles

Depuis le worktree isolé, après préparation des dépendances verrouillées et du cache existant :

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
$env:CODENOMAD_PROFILE = 'trial-rune-tests'
node scripts/rune/prepare.mjs --check
cargo +1.99.1 test --offline --workspace
cargo +1.99.1 run --offline -p rune-style-policy -- packages/rune-app/src
cargo +1.99.1 build --offline -p codenomad-rune-app --bin codenomad-rune
cargo +1.99.1 build --offline --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune
node scripts/rune/check-production.mjs --binary "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe" --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/codenomad-rune.wasm"
cargo +1.99.1 build --offline --locked -p codenomad-rune-app --bin codenomad-rune --features test-support
cargo +1.99.1 build --offline --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune --features test-support
$env:RUNE_CLIENT_EXE = "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe"
node scripts/rune/headless.mjs --binary $env:RUNE_CLIENT_EXE
node --test scripts/rune/*.test.mjs
node scripts/rune/component-inventory.mjs --check
node scripts/rune/generate-theme.mjs --check
node scripts/rune/generate-catalogues.mjs --check
```

Pour les scénarios avec le serveur partagé, construire celui-ci depuis ce worktree dans son cache Cargo existant, puis fournir son chemin absolu dans `RUNE_SERVER_EXE` :

```powershell
node packages/rune-app/fixture.mjs --probe-contract
node packages/rune-app/recovery-fixture.mjs
node packages/rune-app/launcher-fixture.mjs --with-tools
node packages/rune-app/launcher-fixture.mjs --controls
```

Le test réel de serveur enfant exige le binaire explicitement fourni :

```powershell
$env:CODENOMAD_HOST_TEST_SERVER = $env:RUNE_SERVER_EXE
cargo +1.99.1 test --offline -p codenomad-rune-app --bin codenomad-rune platform::host::tests::real_serve_bootstrap_stop_and_new_generation -- --ignored --exact
```

Les commandes de capture Solid/Rune se trouvent dans `scripts/rune/parity/README.md` ; celles du bundle et du smoke web dans `scripts/rune/web-README.md`. Définir `PLAYWRIGHT_BROWSERS_PATH` lorsqu'un cache de navigateur privé est utilisé.

## Campagnes OpenCode réel et presse-papiers Windows

La couverture de référence du prototype comprend l'ouverture visible Windows de 10 000 messages, la sélection/copie d'un bloc dans le presse-papiers Windows, deux échanges avec OpenCode 2.3.2, une reprise de 600 messages stockés par le vrai service et une coupure pendant une réponse réelle. La comparaison finale portait sur 603 lignes et l'ancre conservée. Le choix du modèle et l'arrêt ont aussi fait l'objet d'un essai réel, avec outils interdits. Un essai de modèle a atteint son délai sans texte ; cette limite reste à qualifier.

La qualification actuelle du portage s'appuie sur les exécutions du tableau et les preuves correspondantes. La validation complète de l'alpha demande les permissions et les questions avec OpenCode réel, les sessions longues réelles, la persistance des projets/onglets/brouillons et une journée de travail. Les essais réels utilisent des sessions jetables et des outils interdits sauf nécessité du cas.

## Points à vérifier

- CI Windows, macOS et Linux effectivement exécutée, avec les captures et résultats de chaque runner.
- Raccord du collecteur de latence aux marqueurs du banc TUI, puis mesures comparables.
- Parité visuelle, accessibilité et interactions des écrans et composants du tableau Solid/Rune.
- Coquille web connectée : liste des sessions et lecture d'une conversation par les véritables contrats serveur.
- Fenêtre d'historique au-delà des 2 048 messages ou 8 Mio résidents : pagination avec éviction et restauration de l'ancre à qualifier pour les très longues sessions. La scène de charge locale utilise son propre jeu de 10 000 messages.
- Clavier virtuel, IME, correction, dictée, lecteur d'écran, défilement tactile et consommation sur téléphone physique.
- Installation, mises à jour signées, retour arrière et migration depuis Tauri sur les trois systèmes avant la bascule.
