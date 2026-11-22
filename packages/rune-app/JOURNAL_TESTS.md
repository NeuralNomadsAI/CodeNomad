# Journal des tests Rune

## Périmètre

Worktree : `D:/CodeNomad/.codenomad/worktrees/rune-foundations-20261122`.

L'application est dans `packages/rune-app`, le client partagé dans `crates/codenomad-client` et le thème/catalogue dans `crates/rune-theme-codenomad`. Les sorties de test restent ignorées par Git : `target/`, `packages/rune-app/fixture-profile/` et les journaux `.tmp-rune-*.log`.

Les essais automatiques utilisent des profils `trial-*`, des projets synthétiques, des ports éphémères et des processus possédés par la fixture. Les interactions sont simulées dans le runtime ou dans Chromium headless. La copie testée du presse-papiers est en mémoire.

## Vérifications du portage

| Cas | Environnement | Résultat et preuve |
|---|---|---|
| Client HTTP/SSE asynchrone, bornes, annulation, scopes, fragments et provenance, réparations et diagnostics privés | Réseau loopback jetable et tests de contrats | 24 tests réussis ; `.tmp-rune-fragments-final-tests.log` |
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
| Coquille web connectée, cookies, refus 401, deux pages de sessions, historique exact, session vide puis retour et EventSource | Bundle produit WASM, serveur Rust réel et OpenCode simulé, six contextes clairs/sombres bureau/tablette/téléphone | Réussi, 24 listes, aucune création ni envoi, arrêt serveur zéro ; `target/rune-web-tests/launcher-54c0e861-176c-4317-96bb-098afd95965f/proof.json` et `browser/smoke-report.json` |
| CI Windows/macOS/Linux : générations, tests natifs, builds produit/qualification natif et WASM, isolation et captures offscreen ; parité Solid du contrôle de fermeture sous Windows | Runners GitHub sur `407165952` | Trois jobs réussis ; [campagne 44977149825](https://github.com/NeuralNomadsAI/CodeNomad/actions/runs/44977149825) |
| Banc Rune/TUI optimisé, historique de 300 tours et concurrence 8/32 | Builds release du client et du serveur Rust, daemon OpenCode 2.3.2 privé et fournisseur local | Campagne interrompue au tour 1/L8 : marqueur final absent ; six échantillons conservés, admission des budgets ouverte. Preuves : `.tmp-rune-latency-release-bench.log`, `scripts/perf/run/perf-DMRV5I/` |
| Banc Rune/TUI optimisé après correction des fragments, trois tours L8/L32 | Même charge de 300 tours, builds release, OpenCode réel privé et fournisseur local | 12 échantillons réussis, 25/25 marqueurs par échantillon ; quatre seuils admis, ratio avec plancher 50 ms = 1,00 ≤ 1,15. `scripts/perf/run/perf-gZnlJ0/`, `.tmp-rune-fragments-budget-check.log`, `target/rune-latency-final-e3f137bf4.md` |
| Sonde de latence : clipping vertical/horizontal, marqueur complet, encre effectivement peinte puis effacée | Runtime Rune et peinture CPU réelle, option `test-support` | 1 test réussi ; `.tmp-rune-latency-paint-test.log` |
| Texte en streaming après un outil, ordinaux, préfixes ouverts, clôtures et fins complètes | Helper partagé et véritable rendu Rune | Défaut reproduit dans `.tmp-rune-mixed-stream-before.log`, puis corrigé ; 69 tests Rust réussis et un essai réel ignoré par défaut dans `.tmp-rune-fragments-final-tests.log` |
| Deux envois avec outils et texte visible avant chaque fin de réponse | Serveur Rust réel, OpenCode simulé, fragments à 15 ms, flux libéré par ACK du rendu de l'assistant exact | Deux ACK distincts en phase `Streaming`, après outil, arrêt serveur 0 ; `.tmp-rune-fragments-tools-shutdown.log` |
| Relecture d'un début déjà fermé, deux deltas répétés, coupures, pages périmées et ancre absente | Même serveur partagé et fixture native alignée sur les événements de fragments | 606 lignes exactes, saut d'ancre 0, 23 pages et un seul prompt ; `.tmp-rune-fragments-recovery.log` |
| Préflight du banc TUI existant, Rune et TUI, fournisseur local avec vrai OpenCode 2.3.2 privé | Un tour, une conversation, un tour d'historique ; build Rune de développement | Dix marqueurs sur dix et cinq touches par client ; `scripts/perf/run/perf-ItYdAZ/results/` ; présence plugin fermée et serveur Rust arrêté proprement |
| Primitives de reprise : snapshot texte, limites UTF-16, occurrences distinctes, conservation du fichier et verrou exclusif du profil | Tests Rust, répertoires propres au worktree | 81 tests et exemples réussis, deux essais réels ignorés par défaut ; `.tmp-rune-restore-base-clean.log` |
| Même codec et adaptateur de stockage navigateur ; frontière des styles et dépendance épinglée propre | Compilation WASM du produit, analyse AST et contrôle de préparation | Réussi ; `.tmp-rune-restore-base-wasm.log`, `.tmp-rune-restore-base-policy.log` |
| Réouverture du profil, bootstrap renouvelé, refus du second propriétaire sans invalider le premier, libération après arrêt et configuration conservée entre deux lancements | Véritable `codenomad-rs serve`, profil `trial-*` possédé, OpenCode privé absent | Un test explicite réussi, deux démarrages et deux arrêts confirmés sans terminaison forcée, sorties 0 ; `.tmp-rune-restore-base-owned-server.log` |
| Identité serveur opaque, deux occurrences indépendantes du même dossier, claims et ACK de nettoyage | Client Rust réel contre fixtures HTTP loopback déterministes | 28 tests client réussis, dont quatre cas HTTP du catalogue ; cible WASM vérifiée ; `.tmp-rune-workspace-claims-tests.log`, `.tmp-rune-workspace-claims-wasm.log` |
| Sélection, fermeture et New dans la bande rune-kit, noms accessibles et direction EN/HE | Véritable Runtime Rune, thème et catalogues générés | 9 tests et 2 exemples compile-fail réussis ; thème vérifié en WASM. `.tmp-rune-project-tabs-final-tests.log`, `.tmp-rune-project-tabs-wasm.log`. La comparaison visuelle avec Solid reste à qualifier. |
| Métadonnées d'une session absente de la première page, validation de l'identité et du dossier, une lecture ciblée | Client HTTP loopback | 29 tests client réussis via `cargo +1.99.1 test --offline --locked -p codenomad-client` ; commit `25a0196d8`. |
| Onglets accessibles sur le web, contrôles de fermeture frères, sélection clavier et direction EN/HE | Véritable Runtime et arbre public `a11y_json` | Quatre tests ciblés réussis via `cargo +1.99.1 test --offline --locked -p rune-theme-codenomad tabs::` ; commit `7c7b7d97d`. Reproduction autonome compilée transmise dans [Rune 1344](https://github.com/anomalyco/rune/issues/1344) ; groupement tablist et parité visuelle à qualifier. |
| Deux occurrences possédées du même dossier, refus d'un claim étranger, annulation et suppression ciblées | Serveur Rust réel partagé, OpenCode simulé isolé | Réussi ; `.tmp-rune-workspace-claims-real.log`, profil `launcher-43443306-aa14-4bb3-b742-17374d1a9bd9`. Aucun prompt ni création de session, inventaire final vide, dossier conservé, sortie serveur zéro. |
| Restauration de deux onglets, session sélectionnée et brouillons Unicode sur trois processus ; deux réponses distinctes en streaming puis absence de brouillon ressuscité | Binaire natif sans fenêtre, serveur Rust réel, OpenCode simulé | Réussi sur l'état de développement précédant les derniers correctifs d'onglets et de titre ; `.tmp-rune-window-restore-real.log`, profil `launcher-3981d16b-ef26-4531-98e5-f0bf17b77ba8`. Deux créations, deux prompts, sortie serveur zéro. Revalidation finale requise. |
| Régression de deux réponses après outils, avec acquittement du texte visible pendant Streaming | Serveur Rust réel et OpenCode simulé, entrées Rune locales | Réussi ; `.tmp-rune-window-tools-regression.log`, profil `launcher-dfb91ef2-da00-4e66-a49e-9bb84a828065`. Deux acquittements distincts et sortie serveur zéro. |
| Rechargement réel du document WASM, deux onglets, brouillons et sélection ; ordre de sauvegarde et nettoyage au départ | Chromium headless, bundle produit, serveur Rust réel, OpenCode simulé | En échec : onglets, titres et brouillons restaurés, mais aucun callback produit de sauvegarde/nettoyage observé après pagehide. Preuve instrumentée par document : `target/rune-web-tests/launcher-d8397781-c1b9-4ff7-ab47-1f9d746cdd90/browser/desktop-light-proof.json`. Scénarios quota et téléphone encore à atteindre. |
| Annulation avant réception de la création, borne/expiration du registre, identités Unicode et espaces JS | Serveurs TypeScript et Rust séparés, vrais daemons OpenCode 2.3.2 privés | 42 statuts et effets identiques, sans modèle ni outil ; preuve dans le worktree serveur séparé `rs-workspace-early-cancel-20261122-a8f31/target/workspace-cancel-bench/workspace-claims.json`. [PR serveur 1672](https://github.com/NeuralNomadsAI/CodeNomad/pull/1672), commit `9e0913e8` ; 255 tests unitaires et quatre tests de lancement Windows réussis, un test ignoré. CI complète encore en qualification. |
| Onglets fermables : boutons de sélection/fermeture frères, flèches/Home/End et miroir public web | Runtime Rune épinglé, quatre tests ciblés du composant partagé | Réussi ; `.tmp-rune-tabs-web-green.log`. Les deux reproductions autonomes reproduisent les omissions amont (`target/rune-tab-upstream-closed.log`, `target/rune-tab-upstream-plain.log`) ; [issue Rune 1344](https://github.com/anomalyco/rune/issues/1344). Regroupement web `tablist`, lecteur d'écran physique et comparaison visuelle Solid à qualifier. |
| Reprise d'une session absente de la première page : titre autoritaire, lecture unique, identité et dossier validés | Fixture HTTP loopback et client partagé | 29 tests client réussis avec `cargo +1.99.1 test --offline --locked -p codenomad-client` ; cas `binding_returns_the_validated_native_session_without_a_list_or_second_read`. |

Le préflight qualifie le parcours du banc ; les trois tours optimisés aux niveaux 8 et 32 admettent ses budgets. L'endpoint Rune couvre le tampon CPU et sa validation d'encre ; la présentation physique/GPU a sa qualification distincte.

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

Le journal du prototype décrit une ouverture visible de 10 000 messages, une copie dans le presse-papiers Windows, deux échanges OpenCode et une reprise réelle de 600 messages donnant 603 lignes finales. Les traces détaillées citées pour ces cas restent à retrouver ou les essais à reproduire pour la qualification du portage.

La preuve conservée du choix de modèle et de l'arrêt réel est `D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/fixture-profile/controls-live-2e53761f-1dd1-443b-b51a-db47bb1b31f8/proof.json` : résultat zéro, événements texte et interruption, session nettoyée. Une répétition a atteint son délai avant le texte, consignée dans le journal source ; la disponibilité du modèle reste à qualifier.

La qualification actuelle du portage s'appuie sur les exécutions du tableau et les preuves correspondantes. La validation complète de l'alpha demande les permissions et les questions avec OpenCode réel, les sessions longues réelles, la persistance des projets/onglets/brouillons et une journée de travail. Les essais réels utilisent des sessions jetables et des outils interdits sauf nécessité du cas.

## Points à vérifier

- Raccord des primitives de snapshot et stockage à la restauration des projets, onglets et brouillons ; reprise du navigateur, refus de quota et fermeture d'onglet.
- Présentation physique/GPU et mesures sur les autres matériels, au-delà de l'endpoint CPU qualifié.
- Parité visuelle, accessibilité et interactions des écrans et composants du tableau Solid/Rune.
- Accès web HTTPS appairé, puis écriture et commandes d'agent par les véritables contrats serveur.
- Fenêtre d'historique au-delà des 2 048 messages ou 8 Mio résidents : pagination avec éviction et restauration de l'ancre à qualifier pour les très longues sessions. La scène de charge locale utilise son propre jeu de 10 000 messages.
- Clavier virtuel, IME, correction, dictée, lecteur d'écran, défilement tactile et consommation sur téléphone physique.
- Installation, mises à jour signées, retour arrière et migration depuis Tauri sur les trois systèmes avant la bascule.

## Reproduire les primitives de restauration

Depuis le worktree, avec le cache `CARGO_TARGET_DIR` existant :

```powershell
cargo +1.99.1 test --offline --locked --workspace
$env:CODENOMAD_HOST_TEST_SERVER = 'D:/chemin/worktree-serveur/target/release/codenomad-rs.exe'
cargo +1.99.1 test --offline --locked -p codenomad-rune-app owned_process_releases_lock_only_after_closure -- --ignored
cargo +1.99.1 build --offline --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune
```

Le test réel crée son profil sous `target/rune-host-tests`, puis le retire après fermeture. Le serveur peut enregistrer son identifiant au premier démarrage ; les réouvertures conservent cette configuration. Le codec porte le sous-ensemble texte de l'enveloppe v1, dans un stockage alpha distinct du profil Tauri. Le raccord de l'interface, les erreurs de quota du navigateur et la restauration après fermeture de l'application demandent leurs essais de bout en bout.
