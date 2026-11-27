# Application Rune

Le client natif et WebAssembly utilise le même état et les mêmes écrans. Le contrat HTTP/SSE, la pagination et la reprise sont dans `crates/codenomad-client`. Le thème et les dix catalogues sont générés depuis les sources Solid dans `crates/rune-theme-codenomad`.

Les conventions, correspondances et critères de qualification sont dans [RUNE.md](../../dev-docs/RUNE.md). Le contrat navigateur et les essais mobiles sont détaillés dans [RUNE_WEB.md](../../dev-docs/RUNE_WEB.md).

## Construire

Depuis ce worktree isolé, définir `CARGO_TARGET_DIR` vers le cache Cargo existant avant toute compilation :

```powershell
cargo +1.99.1 build --locked -p codenomad-rune-app --bin codenomad-rune
cargo +1.99.1 test --locked --workspace
cargo +1.99.1 run --locked -p rune-style-policy -- packages/rune-app/src
cargo +1.99.1 build --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune
cargo +1.99.1 build --locked --target x86_64-linux-android -p codenomad-rune-app --example android --features android
node scripts/rune/bundle-android.mjs --lib "$env:CARGO_TARGET_DIR/x86_64-linux-android/debug/examples/libandroid.so" --abi x86_64
```

L'APK Android est la même application, compilée en bibliothèque pour l'hôte Android natif de Rune (`aarch64-linux-android` et `--abi arm64-v8a` pour un téléphone, `x86_64` pour l'émulateur). La compilation demande le NDK (`CC_<cible>` et `CARGO_TARGET_<CIBLE>_LINKER` pointant sur son clang), l'empaquetage le SDK Android, un JDK et Gradle dans le `PATH`. Le script prend l'hôte Kotlin de Rune dans le checkout verrouillé par Cargo et écrit l'APK sous `target/rune-android`. Sur Android l'application ne lance pas de serveur : elle s'ouvre sur l'adresse du serveur du lanceur. Pour un essai, `node packages/rune-app/fixtures/android-native-serve.mjs` (avec `RUNE_SERVER_EXE`) tient un serveur Rust possédé sur la boucle locale, avec un point d'accès OpenCode synthétique ; `adb reverse tcp:3000 tcp:3000` le rend joignable depuis l'appareil à l'adresse par défaut du lanceur. Le serveur n'admet que son propre port de boucle locale : la redirection garde le même port.

Le binaire natif est `$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe` sous Windows. Cargo résout Rune et ses correctifs de plateforme à la révision Git épinglée dans le manifeste du workspace. Le verrou Cargo à sa racine conserve les versions résolues ; les scripts de packaging trouvent les polices via ses métadonnées.

## Ouvrir une conversation

Le lanceur propose l'adresse et l'authentification du serveur, l'ouverture d'un dossier, ses sessions et la création d'une session. Les identifiants sont résolus par le client. La liste demande 200 sessions par page et filtre les titres chargés. Un brouillon ou une demande en cours bloque la navigation ; une création dont la réponse est incertaine exige une actualisation avant nouvel essai.

Entrée envoie, Maj+Entrée insère une ligne. Le fil conserve l'ancre pendant le chargement de messages précédents et la reprise. Les blocs d'outils affichent état, entrée et sortie consultables. Les contrôles d'agent proposent modèle et variante, réponses aux permissions et questions, et interruption.

Le client demande au plus 200 messages par page et borne la fenêtre résidente à 2 048 messages et 8 Mio ; une réponse HTTP est limitée à 2 Mio. Atteindre une limite conserve un état d'erreur explicite. La scène synthétique de 10 000 messages qualifie séparément le moteur de rendu.

Le navigateur utilise son origine et les cookies de cette origine. Le dossier désigne le système de fichiers du serveur. Les chemins absolus Windows et POSIX sont traités selon leur forme serveur.

## Serveur enfant isolé

Le mode natif explicite lance un serveur possédé par Rune si ces trois paramètres sont fournis :

- `RUNE_SERVER_BIN` : chemin absolu du binaire `codenomad-rs`.
- `RUNE_HOST_ROOT` : chemin absolu du dossier du profil isolé.
- `CODENOMAD_PROFILE` : nom `trial-*`.

`RUNE_BACKEND` sélectionne un serveur externe et prend priorité sur ce mode. Le propriétaire du processus réalise l'authentification bootstrap et l'arrêt sur son worker. La fermeture de la boucle Rune attend sa terminaison. Le navigateur publie le lancement local comme indisponible.

Le mode par défaut crée un dossier neuf. `RUNE_HOST_PERSISTENT=true` permet de rouvrir le même profil `trial-*` : un marqueur valide son identité et un verrou système protège toute la durée de vie du serveur enfant. La configuration du dossier est conservée.

La restauration conserve un snapshot borné des onglets, sessions sélectionnées et brouillons texte, dans un fichier atomique sous le profil natif isolé ou dans le stockage de session du navigateur. La reconnexion valide le serveur et la session sauvegardés avant de les lier à l'onglet.

## Vérifications sans fenêtre

Les sondes natives, la galerie et les scènes synthétiques sont compilées avec la feature explicite `test-support`. Le produit par défaut conserve l'inspection et les entrées simulées de Rune sur ses écrans réels. La CI vérifie les artefacts natif et WASM par défaut avant de construire ceux de qualification.

```powershell
cargo +1.99.1 build --locked -p codenomad-rune-app --bin codenomad-rune --features test-support
$env:RUNE_CLIENT_EXE = "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe"
$env:RUNE_SERVER_EXE = 'D:/chemin/worktree-serveur/packages/server-rs/target/debug/codenomad-rs.exe'
node packages/rune-app/fixtures/fixture.mjs --probe-contract
node packages/rune-app/fixtures/launcher-fixture.mjs
node packages/rune-app/fixtures/launcher-fixture.mjs --uncertain-create
node packages/rune-app/fixtures/launcher-fixture.mjs --with-tools
node packages/rune-app/fixtures/launcher-fixture.mjs --controls
node packages/rune-app/fixtures/recovery-fixture.mjs
node packages/rune-app/fixtures/rust-fixture.mjs --probe-slash
node packages/rune-app/fixtures/rust-fixture.mjs --probe-attachments
node packages/rune-app/fixtures/rust-fixture.mjs --prompt-history --history-worktree
node scripts/rune/headless.mjs --binary $env:RUNE_CLIENT_EXE
```

Les fixtures créent leurs projets, profils `trial-*`, ports éphémères et processus ; OpenCode est simulé dans ces scénarios. Le serveur Rust reste réel. `RUNE_CLIENT_EXE` et `RUNE_SERVER_EXE` sélectionnent des exécutables absolus ; le client utilise sinon le cache `CARGO_TARGET_DIR`, ou `target` à la racine du workspace. `rust-fixture.mjs` accepte un dossier absolu `RUNE_FIXTURE_ARTIFACTS` pour conserver ses profils et journaux.
Les runners contrôlent `--test-support-info` avant de lancer une fixture. Les implémentations des sondes vivent sous `tests/probes/` et sont propres à la cible native.

`node packages/rune-app/fixtures/files-fixture.mjs` vérifie le client typé Files avec le vrai serveur Rust et des fichiers jetables. Fournir `RUNE_SERVER_EXE` absolu et un `CARGO_TARGET_DIR` existant ; le test Cargo est exécuté avec `--offline --locked`. Le serveur utilise un service natif de métadonnées simulé ; Unicode, octets binaires, versions, limites et liens sont lus sur le vrai système de fichiers du profil privé.

`node packages/rune-app/fixtures/native-store-fixture.mjs --opencode <chemin-absolu-opencode>` qualifie le stockage natif dans un daemon privé avec le plugin d'historique de production : 600 messages importés, session hors première page, trois démarrages Rune, deux occurrences et brouillons, pagination et ancre de lecture. Les sessions préparées portent `deny-all` et les relais du banc rejettent les mutations d'envoi, de création, de fork et d'import de session (chemins bruts et décodés) ; les sessions de préparation sont supprimées par identité. Le processus OpenCode reste actif entre les trois clients. Les preuves sont sous `scripts/perf/run/trial-rune-store-*`.

`node packages/rune-app/fixtures/e2e-journey.mjs --opencode <chemin-absolu-opencode>` (ajouter `--mode web` sous Linux et macOS) ouvre un dépôt Git jetable depuis Rune, crée une conversation et vérifie l'autorisation d'écriture, le fichier, le diff, le commit, la recherche dans les commits et la restauration de la session. OpenCode et le modèle déterministe écoutent uniquement sur des ports loopback éphémères, dans un profil privé sans clé utilisateur.

Construire `RUNE_CLIENT_EXE` avec `test-support` et `RUNE_SERVER_EXE` depuis le même checkout. Pour Chromium, installer Playwright Chromium et empaqueter le WASM produit avec `node scripts/rune/bundle-web.mjs --wasm <wasm> --out target/rune-web-journey` (`RUNE_WEB_DIR` permet de choisir le bundle). Le mode `--mode windows` ou `--mode web` exécute un seul client ; le navigateur émule un mobile sur l'origine locale authentifiée. Le runner ferme les processus et supprime le profil jetable avec son dépôt. Les PNG, arbres d'accessibilité et `journey-report.json` restent dans `.codenomad/cargo-targets/e2e-journey/journey-*`.

`cargo build --locked -p codenomad-host-process --bin codenomad-fixture-job` prépare le lanceur des bancs (Job Object Windows ou groupe POSIX supervisé, arrêté automatiquement si le processus parent disparaît). Celui-ci est recherché dans `CARGO_TARGET_DIR/debug` ou `target/debug` ; `CODENOMAD_FIXTURE_JOB_EXE` accepte un chemin absolu.

Les bancs `live*.mjs`, `interactive-live.mjs`, `controls-live.mjs`, `pending-live-fixture.mjs` et `real-history-*.mjs` prennent `--opencode <exécutable-absolu>`. Ils démarrent une copie privée sur un port éphémère, vérifient le propriétaire du socket loopback puis le PID annoncé, et utilisent un fournisseur synthétique local. Les étapes d'historique s'enchaînent avec `real-history-prepare.mjs --opencode <exécutable-absolu> --prepare` (crée le profil jetable et `session.json`), `real-history-seed.mjs --opencode <exécutable-absolu> --seed <session.json>` (écrit `seeded.json`), `real-history-fixture.mjs --opencode <exécutable-absolu> <seeded.json>` et `real-history-cleanup.mjs --opencode <exécutable-absolu> --cleanup <seeded.json>`. `interactive-live.mjs` ouvre une fenêtre sur un historique synthétique.

Les preuves et journaux d'exécution sont écrits dans les répertoires ignorés `target/`, `evidence/` et `fixture-profile/`, ou joints aux artefacts CI. Ils distinguent les environnements et les vérifications exécutées. La comparaison Solid/Rune, les mesures face à la TUI et les essais sur téléphone gardent leurs critères propres.
