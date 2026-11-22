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
| Restauration de deux onglets, session sélectionnée et brouillons Unicode sur trois processus ; deux réponses distinctes en streaming puis absence de brouillon ressuscité | Binaire natif sans fenêtre, serveur Rust réel, OpenCode simulé | Réussi après les correctifs d'onglets, titre et fermeture ; `.tmp-rune-window-restore-native-final.log`, profil `launcher-9df6bdc3-cf9a-4517-bc96-7a49363c2c2a`. Deux créations, deux prompts, deux preuves de texte visible en phase Streaming et sortie serveur zéro. |
| Pagination et reconnexion après raccord des onglets et restauration | Même binaire natif et serveur partagé, OpenCode simulé | 606 lignes exactes, saut d'ancre maximal zéro, 23 pages et un prompt ; `.tmp-rune-window-restore-recovery-final.log`. Les erreurs de transport et l'ancre manquante sont injectées par la fixture. |
| Régression de deux réponses après outils, avec acquittement du texte visible pendant Streaming | Serveur Rust réel et OpenCode simulé, entrées Rune locales | Réussi ; `.tmp-rune-window-tools-regression.log`, profil `launcher-dfb91ef2-da00-4e66-a49e-9bb84a828065`. Deux acquittements distincts et sortie serveur zéro. |
| Rechargement réel du document WASM, deux onglets, brouillons et sélection ; ordre de sauvegarde et nettoyage au départ | Chromium headless, bundle produit, serveur Rust réel, OpenCode simulé | En échec : onglets, titres et brouillons restaurés, mais aucun callback produit de sauvegarde/nettoyage observé après pagehide. Preuve instrumentée par document : `target/rune-web-tests/launcher-d8397781-c1b9-4ff7-ab47-1f9d746cdd90/browser/desktop-light-proof.json`. Scénarios quota et téléphone encore à atteindre. |
| Fermeture corrigée, restauration, quota et nouvel essai ; préservation des records étrangers | Même bundle produit rebâti, Chromium bureau clair et téléphone émulé sombre | Réussi ; `.tmp-rune-pagehide-final.log` et `target/rune-web-tests/launcher-2a54163b-63d6-47c1-a4b7-127b56bbf99e/proof.json`, résultat et sortie serveur zéro. Avant reconnexion : bureau 2→0 records, téléphone 6→4 avec seuls les deux records possédés supprimés ; quota 2→2 et 6→6 sans marqueur ni DELETE. Événement BFCache synthétique : document et état préservés, interface utilisable ; cycle BFCache réel à qualifier. Le négatif sans fallback Drop conserve les deux records (`launcher-ab47040d-a233-4a3d-9afc-0d2f2aa3b4be`). Les keepalive sont prouvés par l'inventaire autoritaire ; leur interception Playwright au départ du document est incomplète. |
| Ensemble Rust, politique de styles, produit sans sondes et générateurs | Cache Cargo existant, natif Windows et WASM | 94 tests et exemples réussis, deux essais réels ignorés ; `.tmp-rune-window-restore-tests-final.log`. Styles et isolation produit réussis (`.tmp-rune-window-restore-policy-final.log`, `.tmp-rune-window-restore-production-final.log`). Sept tests Node réussis, thème/catalogues/inventaire et révision Rune contrôlés. |
| Politique CI des téléchargements et ordre de construction | Tests existants `.github/scripts/download-cache.test.cjs` et `binary-build-order.test.cjs` | 19 tests réussis ; `.tmp-rune-ci-policy-final.log`. Le workflow Rune restaure les téléchargements vérifiés par le helper partagé et qualifie les fixtures natives de restauration/reprise avec le serveur Rust construit dans chaque runner. Résultats des nouveaux jobs trois OS à relever après exécution. |
| Fermeture pendant POST retenu, ACK retenu et ACK avec échec du stockage ; successeur du même dossier | Runtime natif sans fenêtre, serveur Rust partagé avec early-cancel, OpenCode simulé | Trois cas réussis : publication tardive refusée, successeur préservé, inventaire final zéro ; `fixture-profile/launcher-fdced542-c6e1-461e-86ff-a816709760f9/pending-open-proof.json` et `.tmp-rune-pending-open-native.log`. Une création envoyée sans reçu garde explicitement son incertitude malgré l'ACK d'annulation ; les reçus connus sont soldés. Deux tests ciblés passent ; 94 tests unitaires du workspace réussis, deux essais réels ignorés (`.tmp-rune-pending-open-tests.log`). Compilation partagée WASM contrôlée (`.tmp-rune-pending-open-wasm-check.log`) ; nettoyage en vol navigateur encore à raccorder. |
| Annulation avant réception de la création, borne/expiration du registre, identités Unicode et espaces JS | Serveurs TypeScript et Rust séparés, vrais daemons OpenCode 2.3.2 privés | 42 statuts et effets identiques, sans modèle ni outil ; preuve dans le worktree serveur séparé `rs-workspace-early-cancel-20261122-a8f31/target/workspace-cancel-bench/workspace-claims.json`. [PR serveur 1672](https://github.com/NeuralNomadsAI/CodeNomad/pull/1672) fusionnée dans `feat/rust-server` par `f2f9df378` ; 255 tests unitaires et quatre tests de lancement Windows locaux réussis, un test ignoré. Tests unitaires CI réussis sur trois OS. Les échecs CI de lancement, plugin pruning et Tauri reproduisent les erreurs antérieures ; le conflit du test de cache est présent dans la base. Rapport `target/ci-server-baseline-review.md` du worktree serveur. Suites interrompues et leurs tests ultérieurs encore à qualifier. |

Le préflight qualifie le parcours du banc ; les trois tours optimisés aux niveaux 8 et 32 admettent ses budgets. L'endpoint Rune couvre le tampon CPU et sa validation d'encre ; la présentation physique/GPU a sa qualification distincte.

La réorganisation conserve les scénarios : reprise de 606 lignes avec saut d'ancre nul (`.tmp-rune-domain-recovery.log`), deux envois avec outils (`.tmp-rune-domain-launcher.log`), commandes d'agent (`.tmp-rune-domain-controls.log`), quatre captures natives (`target/rune-domain-headless/qualification.json`) et six contextes web (`target/rune-web-tests/trial-lmH7lV/proof.json`). Le contrôle de styles recompilé passe (`.tmp-rune-domain-policy.log`).

L'audit lexical relu relève 48 appels `unwrap`/`expect` produit, 125 dans les tests, 103 dans les sondes et 2 au build. Les invariants concernent surtout les données générées, les fenêtres bornées et l'état UI. Les échecs de création d'exécuteur, de timers navigateur et l'empoisonnement de mutex restent à durcir. Le registre et ses empreintes sont dans `target/panic-audit.json`, avec analyse dans `target/panic-audit.md`. Les deux ordres de retrait pendant la saisie testés réussissent.

Le serveur partagé est construit depuis ce worktree et son intégration Rust. Le cache de compilation réutilisé peut se trouver sous un autre worktree ; son emplacement constitue un cache, tandis que le manifeste passé à Cargo détermine les sources.

## Comparaison des onglets projet

Le banc des onglets projet conserve 24 paires Solid/Rune réelles (huit contextes, trois états), trois fiches AST, arbres accessibles et six scripts d'entrées Rune par identité sous `target/rune-parity/project-tabs/evidence.json`. Les écarts pixel diagnostiqués vont de 15,07 % à 56,75 % ; aucun seuil d'admission n'est choisi, la parité reste ouverte. Le composant Solid de fermeture répond au clic mais pas à Espace dans les six contextes de base ; le comportement clavier accessible Rune reste conservé. Commande : `node --import tsx scripts/rune/parity/project-tabs.mjs --binary <galerie-absolue>`. Détails dans `scripts/rune/parity/project-tabs.md`.

Le port de la géométrie utilise les métriques CSS générées et partage le SVG de fermeture existant. Alpha mesure 104,609 px côté Solid et 104,6 px côté Rune, pour 39 px de haut. La campagne étendue conserve 40 paires de barres et 32 paires de crops Alpha ; les écarts exacts RGBA Alpha restent de 6,30 % à 10,26 %, sans admission. Encres identiques, empreinte du texte alignée et Segoe UI confirmé côté Solid ; le rendu anticrénelé diffère. Les captures nommées focus ont `focused=true` et `focusVisible=false` côté Rune : une véritable navigation clavier et un contrôle régional sont à qualifier. Retirer Close améliore le ratio global (302→289 pixels différents), ce qui impose des négatifs par région ; voir `target/rune-parity/project-tabs/residual-analysis.md`.

Un défaut de taille de la bande dans la colonne de l'application est reproduit par un vrai Runtime 390×844 : 422 px au lieu de 39. Le correctif partagé donne 39 px de bande et 805 px de conversation. Douze tests thème réussissent, avec preuves `.tmp-rune-strip-column-red.log` et `.tmp-rune-strip-column-green.log` ; les captures de l'application WASM avec cette correction demandent leur revalidation.

La composition complète `crate::view`, avec workspace et chat, conserve historique, agent et composeur dans le viewport natif 390×844 et 1100×900 (`.tmp-rune-workspace-viewport-native.log`). La vérification WASM après restauration passe aussi : profil `launcher-b6160b8a-9788-4f70-b012-3a732194edfa`, bureau et téléphone, quatre étapes contrôlées par deux captures consécutives. Sur téléphone restauré, Modèle/Envoyer/champ sont entièrement visibles ; 112/99/380 pixels de glyphes sont détectés et les contrôles négatifs effacés sont rejetés. Le conteneur décoratif déborde de 5 px de padding, tandis que champ et actions restent dans le viewport. Le signalement de débordement vertical du chat est non reproduit ; aucune correction produit supplémentaire. Preuves et logs : `.tmp-rune-workspace-viewport-browser-final.log` et `target/rune-web-tests/launcher-b6160b8a-9788-4f70-b012-3a732194edfa/browser/`.

La fixture directe monte le véritable `InstanceTab` avec ses providers/CSS : quatorze contextes, 56 paires et cadres de focus, quatorze parcours Rune, fontes prêtes et états immobiles. Le halo extérieur est identique pixel pour pixel dans 56/56 cas. Les labels longs ont reproduit un débordement du contenu du bouton ; le correctif contraint la rangée et le texte, maintient Folder/Close visibles et suit la troncature RTL de la source. Treize tests thème passent. Les contrôles régionaux refusent les budgets permissifs et conservent les négatifs glyphes absents/décalage/cue supprimé. Preuves : `target/rune-parity/project-tab/final-summary.json` et `regional-pixels.json`. Le résidu Close atteint encore 68 canaux malgré SVG/encres/géométrie examinés ; aucun budget d'admission adopté. La barre entière, ses états supplémentaires et la parité complète restent à qualifier.

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

Une campagne native privée OpenCode 2.3.2 et serveur Rust partagé valide les API de permission (`once`, `always`, `reject`, motifs conservés, refus périmés 404), une Form typée Unicode/string/int/bool et son annulation (refus périmé 409). Preuve : `target/rune-real-pending/trial-95f8d8e2-e107-401e-b672-381efdc79522/proof.json`, résultat zéro, zéro modèle/outil, session supprimée, serveur Rust arrêté avec code zéro et daemon privé arrêté. Les demandes proviennent des API natives publiques, sans plugin de simulation. Commande conservée : `node target/rune-real-pending/qualify.mjs`. Cette preuve porte sur les contrats du service et du relais ; le parcours des contrôles Rune demande son exécution propre.

Le parcours des vrais contrôles Rune passe aussi avec ce service : `target/rune-real-pending/trial-2715ab97-7b23-450f-a210-800d15d736bd/proof.json`, cinq cas réussis, cinq arbres accessibles et cinq actions visibles. Les clics et KeyEvent natifs vérifient les trois décisions avec motifs Unicode durables, la question string multiligne/int/bool avec brouillon conservé après actualisation, puis l'annulation et les refus périmés. Résultat zéro, session supprimée, serveur Rust zéro, daemon privé arrêté ; transcript vide et aucun événement d'exécution ou d'outil. Commande : `node packages/rune-app/pending-live-fixture.mjs <chemin-absolu-opencode>`, avec `RUNE_CLIENT_EXE` compilé en `test-support` et `RUNE_SERVER_EXE` partagé. Les demandes sont créées par les API natives publiques ; génération par modèle, navigateur et présentation physique restent à qualifier.

Le journal du prototype décrit une ouverture visible de 10 000 messages, une copie dans le presse-papiers Windows, deux échanges OpenCode et une reprise réelle de 600 messages donnant 603 lignes finales. Les traces détaillées citées pour ces cas restent à retrouver ou les essais à reproduire pour la qualification du portage.

La preuve conservée du choix de modèle et de l'arrêt réel est `D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/fixture-profile/controls-live-2e53761f-1dd1-443b-b51a-db47bb1b31f8/proof.json` : résultat zéro, événements texte et interruption, session nettoyée. Une répétition a atteint son délai avant le texte, consignée dans le journal source ; la disponibilité du modèle reste à qualifier.

La qualification actuelle du portage s'appuie sur les exécutions du tableau et les preuves correspondantes. Les contrôles Rune de permissions et questions sont qualifiés avec les API natives OpenCode réelles. La validation complète de l'alpha demande leur génération par le modèle, les sessions longues réelles, la restauration sur ce stockage et une journée de travail. Les essais réels utilisent des sessions jetables et des outils interdits sauf nécessité du cas.

## Points à vérifier

- Restauration après redémarrage du daemon OpenCode et historique issu d'une session de travail ; qualification complète des onglets par comparaison avec Solid. La campagne native sur messages importés et les créations en vol avec OpenCode simulé sont couvertes séparément.
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

Le test réel crée son profil sous `target/rune-host-tests`, puis le retire après fermeture. Le serveur peut enregistrer son identifiant au premier démarrage ; les réouvertures conservent cette configuration. Le codec porte le sous-ensemble texte de l'enveloppe v1, dans un stockage alpha distinct du profil Tauri.

## Reproduire la restauration de l'interface

Le nettoyage navigateur en vol passe avec le serveur partagé corrigé : `target/rune-web-tests/launcher-fcbf70fb-1365-40fa-a16a-0d986befa75c/browser/pending-open-proof.json`. Quatre départs réels couvrent POST retenu (inventaire 1→0), ACK retenu (2→0), quota (2→1) et snapshot corrompu sans Store valide (2→1). Le successeur du même dossier est préservé ; snapshot/marque précèdent les requêtes keepalive admissibles, et le record adopté est préservé lorsque la sauvegarde échoue. Le document parti abandonne son ACK ; la livraison tardive reste vérifiée séparément en natif. Trois tests du registre, WASM et bundle réussissent. Commande : `node packages/rune-app/launcher-fixture.mjs --web-pending-open`, avec `RUNE_SERVER_EXE` debug du serveur partagé qualifié. Régression bureau/téléphone, quota et BFCache synthétique réussie sur le même bundle : profil `launcher-c9f20cde-7598-4b07-a187-87e69fa4e46e`, sortie serveur zéro.

Les deux revues indépendantes ont reproduit des P2 de la tranche dans `target/rune-review-{contracts,standards}/REPORT.md` : admission épuisée après seize créations rejetées, accumulation de brouillons vides rendant le snapshot impersistable et récupération d'une seule occurrence fermée au lieu de fusionner ses sessions. Corrections et contre-vérifications restent nécessaires avant intégration.

Le correctif des brouillons fait passer les deux reproductions rouges (`drafts-repro.log`, `closed-drafts-repro.log`) et neuf tests Runtime dans `target/rune-review-contracts/cargo-state-green.log`. Vingt-cinq visites/retours et envois restent sérialisables ; un v1 valide à 24 vides accepte un nouveau texte. La fusion conserve les sessions disjointes et la dernière autorité de clear/send, y compris après encode/decode/hydrate, tandis qu'une occurrence intacte récupère le texte. Les sources étrangères sont séparées. Format et budgets v1 conservés ; seuls les clears protégeant un texte d'occurrence sœur occupent un champ persistant. Check WASM réussi : `.tmp-rune-review-fixes-wasm.log`.

La validation d'ensemble du point `5ddce628e` exécute 111 tests/exemples avec succès, deux essais serveur réel ignorés (`.tmp-rune-final-workspace-tests.log`), puis builds produit Windows/WASM et politique de styles (`.tmp-rune-final-product-{native,wasm}.log`, `.tmp-rune-final-style.log`). Le garde a révélé une macro HTTP `write!` non admise dans un test ; son remplacement par `write_all(format!(...))` conserve le garde strict. Les gates indépendants suivants prouvent encore trois P2 : Form dirty perdu par fermeture d'un onglet caché, spelling Windows équivalent perdant un draft et fermeture inactive déplaçant le lecteur en bas. Rapports sous `target/rune-delivery-gate-{contracts,standards}` ; corrections et nouvelle revue nécessaires avant intégration.

Les trois reproductions deviennent vertes (`.tmp-rune-delivery-red.log` puis `-green.log`). Le même prédicat protège actif, cache et bouton Close pour réponses, motifs et opérations en vol. Fermer un onglet inactif conserve ancre, rectangle, focus, curseur et texte actifs. Les chemins Win32 drive/UNC équivalents conservent les drafts, sans fusionner POSIX, drives, backends ou installations distincts. Vérification : 62 tests app réussis et deux ignorés, 30 tests client réussis, builds Windows/WASM et pin Rune propre (`.tmp-rune-delivery-{app,client,native,wasm,source}.log`). Ces régressions Runtime utilisent un transport loopback synthétique ; les campagnes OpenCode réel sont distinctes. Une contre-revue indépendante du nouvel état reste nécessaire.

Le gate indépendant suivant reproduit un P2 à 32 onglets (`target/rune-gate-contracts/REPORT.md`) : l'ouverture remplace le projet actif lorsque la création d'un onglet est refusée. Son harness est rouge puis vert après garde préalable (`.tmp-rune-tab-capacity-red.log`, `-green.log`). Le test permanent vérifie zéro POST/claim et conservation du snapshot, du record, de la sélection et du brouillon ; fermer un onglet permet le nouveau slot, et un slot vide d'origine reste utilisable à la limite. Dix tests d'état et deux tests launcher passent, builds Windows/WASM et absence des sondes dans le produit aussi (`.tmp-rune-tab-capacity-*.log`, `target/rune-tab-capacity-production/production-report.json`). La preuve HTTP utilise un serveur loopback synthétique ; elle complète les campagnes OpenCode distinctes.

Un autre gate neuf reproduit la réapparition d'un texte effacé dans B après livraison depuis A fermé, lors de l'ouverture de C (`target/rune-final-contracts/REPORT.md`, `repro.log`). Le transfert est désormais effectué à la liaison native : le bundle source et les seules copies sœurs pending sont retirés, tandis que textes propres et sessions non livrées restent préservés. Treize tests Runtime et 28 régressions du harness passent (`target/rune-review-contracts/delivery-cargo-green.log`, `delivery-full-green.log`), avec clear/send/modification, fermeture avant liaison, restauration et absence d'effacement par une occurrence intacte. Références canoniques dans `DELIVERY_FIX.md`. Format et limites inchangés ; check WASM réussi (`.tmp-rune-draft-delivery-wasm.log`).

Le refus de création est désormais typé uniquement pour les validations prépublication établies par les serveurs partagés. Trente-deux refus authentiques de dossiers absents puis une ouverture valide passent dans `fixture-profile/launcher-384e505f-f397-4580-b82d-79ff9441d48e/pending-open-proof.json`, inventaire final zéro et serveur arrêté avec code zéro. POST sans reçu, ACK tardif et panne du stockage passent encore ; le premier conserve son incertitude. Six tests catalogue, trois tests opening, build Windows et check WASM réussissent (`.tmp-rune-opening-capacity-*.log`). Les erreurs réseau, réponses génériques/malformées et annulations dont la publication est incertaine gardent leur propriété et la borne d'admission ; le stub générique de la revue conserve donc intentionnellement cette incertitude.

Fournir les exécutables privés dans `RUNE_CLIENT_EXE` et `RUNE_SERVER_EXE`, le cache Cargo existant et le cache Chromium privé dans `PLAYWRIGHT_BROWSERS_PATH` :

```powershell
cargo +1.99.1 build --offline --locked -p codenomad-rune-app --bin codenomad-rune --features test-support
node packages/rune-app/launcher-fixture.mjs --workspace-claims
node packages/rune-app/launcher-fixture.mjs --restore-state
node packages/rune-app/recovery-fixture.mjs
cargo +1.99.1 build --offline --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune
node scripts/rune/bundle-web.mjs --wasm "$env:CARGO_TARGET_DIR/wasm32-unknown-unknown/debug/codenomad-rune.wasm" --out target/rune-web-connected
node packages/rune-app/launcher-fixture.mjs --web-restore
```

Le bundle demande le binaire `wasm-bindgen` verrouillé via `RUNE_WASM_BINDGEN`. Chaque fixture possède son serveur Rust, ses cookies, ses dossiers et son OpenCode simulé. Le test navigateur effectue des mutations de records de projet et des lectures de session ; les prompts et créations de sessions y sont interdits. Les trois processus natifs créent et interrogent uniquement deux sessions synthétiques. `workspace/state.rs` concentre environ 678 lignes ; sa taille reste un point d'attention de lecture.

## Contre-vérification de l'état `72876512e`

Deux relecteurs neufs ont examiné le diff avec l'intégration sans consulter les anciens rapports. Aucun constat moyen ou bloquant démontré. Contrats : 63 tests réussis, deux hôte ignorés, huit tests catalogue HTTP ; test indépendant Runtime/HTTP de lecture ciblée hors première page et rejet d'une session étrangère avec snapshot/brouillon préservés. Standards : client recompilé 30/30, workspace 25/25, plateforme 16 réussis et deux ignorés, launcher 2/2. Ces nombres se recouvrent ; ils ne constituent pas un total unique. Rapports reproductibles : `target/rune-state-acceptance-{contracts,standards}/REVIEW.md`.

La réexécution du workspace suivi réussit : 114 tests/exemples, deux essais hôte explicitement ignorés (`.tmp-rune-state-final-tests.log`). Builds produit Windows et WASM, sources générées/pin et exclusion des sondes réussis (`.tmp-rune-state-final-{native,wasm,production}.log`, `target/rune-state-final-production/production-report.json`). Bundle produit final reconstruit avec wasm-bindgen verrouillé (`.tmp-rune-state-final-bundle.log`).

Le parcours natif à trois processus repasse avec le serveur Rust partagé : deux occurrences du même dossier, deux sessions et brouillons distincts, sélection restaurée, deux réponses observées pendant `Streaming`, troisième ouverture sans résurrection ni envoi automatique. Profil `fixture-profile/launcher-32bb9435-584d-4cbe-a38e-8544c2918264`, commande `node packages/rune-app/launcher-fixture.mjs --restore-state`, sortie zéro (`.tmp-rune-state-final-restore.log`). Le test de reprise repasse avec 606 lignes exactes, 23 pages, un seul prompt et déplacement d'ancre zéro (`node packages/rune-app/recovery-fixture.mjs`, `.tmp-rune-state-final-recovery.log`). OpenCode reste simulé dans ces deux essais.

Le résidu SVG des onglets possède une reproduction autonome publiée : [Rune #1346](https://github.com/anomalyco/rune/issues/1346). L'API publique `icon_coverage` et Chromium diffèrent de 75/255 à 12 px/DPR 1, concordent à 14 px et diffèrent au plus de 1 à 12 px/DPR 2. Les prédictions croisées reproduisent le résidu du composant. Preuves sous `target/rune-parity/close-minimal/` ; aucun seuil, pin ou renderer modifié. Le contrôle WindowClose 14 px et ses négatifs restent réussis. La parité complète des onglets demande sa qualification propre.

Le bundle produit de cet état repasse le navigateur bureau/téléphone avec rechargement, quota et BFCache synthétique : profil `target/rune-web-tests/launcher-05b77a82-ef4d-456a-b328-94b2bc43b2e1` (`.tmp-rune-state-final-web-restore.log`). Créations en vol : les quatre départs navigateur repassent dans `launcher-77a866c0-b938-425b-932e-cdbc60aec5ce` ; la campagne native repasse dans `fixture-profile/launcher-aee61f0d-20ac-4d7c-b97f-b5895ef571cf`, y compris les 32 refus réels puis ouverture valide (`.tmp-rune-state-final-pending-{web,native}.log`). Propriété des records : deux occurrences, refus de claim étranger, successeur protégé, inventaire final zéro (`launcher-84654480-4389-4403-978b-b7881746ecb8`, `.tmp-rune-state-final-claims.log`). Sept tests Node de l'outillage réussissent. Ces campagnes utilisent OpenCode simulé et le serveur Rust partagé.

La CI `44989594455` de cet état révèle un échec macOS dans `termination_confines_and_stops_owned_descendants` : après SIGKILL et collecte du fils direct, la requête `kill(-group, 0)` retourne EPERM. Ubuntu dépasse les tests natifs/WASM/offscreen ; la qualification trois systèmes reste en cours. Le diagnostic est conservé sous `target/rune-ci-state-acceptance/`. La fusion attend la correction et sa preuve sur macOS.

Le correctif `02d83a2b1` classe EPERM comme groupe encore présent et conserve ESRCH comme seule preuve d'absence. Arrêt SIGKILL et erreurs de terminaison restent inchangés. Deux revues ciblées indépendantes favorables, avec test de classification extrait du source réussi chacune : `target/review-owned-group-{contracts,standards}/REVIEW.md`. Leur exécution Windows vérifie la logique, le runner macOS doit qualifier les vrais appels système. Le test Windows des descendants possédés et du processus témoin passe aussi.

Nouvelle exécution des contrôles Rune avec le vrai OpenCode 2.3.2 : `target/rune-real-pending/trial-33423c9d-3ad6-45b4-ab72-81c17e8027ac/proof.json`. Cinq cas réussis, motifs et réponses typées vérifiés, session supprimée, serveur Rust arrêté avec code zéro (`.tmp-rune-state-final-opencode-pending.log`). Commande `node packages/rune-app/pending-live-fixture.mjs <chemin-absolu-opencode>` avec les exécutables privés ; demandes créées par API native, zéro modèle/outil. La scène Runtime de 10 000 messages, interactions et captures sans fenêtre repasse également (`node scripts/rune/headless.mjs --binary <exécutable-test-support> --out target/rune-state-final-headless`).

Les deux tests hôte ignorés dans le workspace standard sont exécutés explicitement avec `CODENOMAD_HOST_TEST_SERVER` pointant sur l'exécutable partagé : `cargo +1.99.1 test --locked -p codenomad-rune-app platform::host -- --ignored`. Deux réussites : bootstrap/arrêt/nouvelle génération et verrou conservé jusqu'à fermeture de la famille possédée (`.tmp-rune-state-final-real-host.log`). Cette exécution qualifie Windows ; le test macOS du groupe de processus conserve son passage CI propre.

Audit de police natif exécuté sans fenêtre : `target/rune-tab-font-audit/proof.json`, six cas Alpha/label long/hébreu clair+sombre, AppSpec et vue de galerie réels. Le même TextSystem configuré par les familles CSS façonne tous les runs en Segoe UI Regular/PostScript SegoeUI, index zéro, SHA-256 `704eada12961a27fd271f7d3b09e2066520e758390c1776744eff430fee30f6e`. La preuve utilise l'API publique de shaping sur le label entier ; le layout tronqué interne garde sa vérification propre. Le résidu texte de 230 reste à expliquer et ne permet aucune admission de parité.

Qualification trois systèmes réussie : [CI 44990217808](https://github.com/NeuralNomadsAI/CodeNomad/actions/runs/44990217808), source produit `02d83a2b1`, jobs Windows/macOS/Linux tous SUCCESS. Chaque job vérifie sources générées, tests natifs, garde de styles, builds natif/WASM, exclusion des sondes du produit, runtime offscreen et restauration via le serveur Rust partagé. Windows valide aussi les captures Solid/Rune WindowClose et leurs contrôles négatifs. Le confinement macOS franchit le vrai appel système et la restauration complète. Les commits suivants de cette qualification ne modifient que la documentation ; aucun module Solid/Tauri supprimé, parité complète des onglets et restauration sur stockage OpenCode réel encore à qualifier.

## Restauration sur stockage OpenCode natif privé

La tranche de restauration est intégrée par le merge `59be0eebf` dans `feat/rust-server`. Sa contre-vérification locale du workspace, du format et des styles réussit (`.tmp-rune-restore-integrated-{tests,style}.log`). La branche suivante qualifie le stockage natif par un banc dédié.

Commande reproductible, avec `RUNE_CLIENT_EXE` compilé en `test-support` et `RUNE_SERVER_EXE` partagé : `node packages/rune-app/native-store-fixture.mjs --opencode <chemin-absolu-opencode>`. Le banc utilise les répertoires privés, le SDK natif import/export, l'installateur et le plugin d'historique de production ; les deux relais interdisent la génération et la création de sessions par Rune. Aucun compte ou accès modèle requis.

Deux campagnes Windows réussissent avec OpenCode 2.3.2 : `scripts/perf/run/trial-rune-store-8f559912-eecf-46d8-8da5-98faa5c92b0c/proof.json`, puis `trial-rune-store-0e01202c-ee67-49db-9e51-ec840acc298c/proof.json` après assertions explicites des fenêtres initiales de 200 lignes et délai global de nettoyage. Trois processus Rune réels en mode offscreen reprennent deux occurrences du même dossier, la sélection et deux brouillons Unicode distincts. Le second modifie un brouillon et sélectionne l'autre onglet ; le troisième retrouve ces changements. La session longue est absente de la première page native de 200 sessions. La restauration effectue des lectures ciblées sans parcourir les curseurs du catalogue.

Le deuxième client charge les 600 lignes stockées, compare tous les identifiants et textes au manifeste natif exporté et conserve l'ancre (déplacement zéro). L'export est identique après chaque client, les records CodeNomad sont tous relâchés et les 204 sessions de préparation sont supprimées exactement par leurs identités. Les trois clients et le serveur Rust sortent avec code zéro ; le daemon privé est arrêté. Journaux `.tmp-rune-native-store-{live,final-live}.log` et preuves adjacentes.

Les 600 messages sont synthétiques, importés par l'API native et réellement stockés ; aucun modèle ou outil exécuté. Le daemon reste actif entre les trois démarrages Rune. Cette campagne conserve séparément les qualifications du redémarrage du daemon, d'un historique de travail et de la présentation physique. Les deux revues indépendantes du nouveau banc et sa CI restent à terminer avant intégration.

Le correctif candidat classe EPERM comme « groupe encore présent », puis conserve l'attente bornée jusqu'à ESRCH ; les erreurs de terminaison restent propagées. [XNU `killpg1`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sig.c) exclut les zombies et peut produire EPERM pour un groupe existant sans membre admissible. La course zombie explique plausiblement la trace, sans observation directe de l'état du processus. Test de classification permanent ajouté ; quatre contrôles logiques indépendants réussissent (`target/rune-state-acceptance-contracts/darwin-query-classification.log`) et les deux tests de confinement Windows passent. La validation du syscall et de la borne sur macOS attend la CI.
