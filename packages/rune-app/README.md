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
```

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

`node packages/rune-app/fixtures/native-store-fixture.mjs --opencode <chemin-absolu-opencode>` qualifie le stockage natif dans un daemon privé avec le plugin d'historique de production : 600 messages importés, session hors première page, trois démarrages Rune, deux occurrences et brouillons, pagination et ancre de lecture. Les générations et créations de sessions par Rune sont refusées par les relais du banc ; les sessions de préparation sont supprimées par identité. Le processus OpenCode reste actif entre les trois clients. Les preuves sont sous `scripts/perf/run/trial-rune-store-*`.

Sous `fixtures/`, `controls-live.mjs` et les scripts `real-history-*` sont des essais explicites avec un OpenCode réel déjà configuré, des sessions jetables et des outils interdits. `interactive-live.mjs` ouvre une fenêtre et demande un dossier et un titre exacts ; ses essais utilisent une copie de la conversation source. Leur lancement interactif appartient à une qualification dédiée.

Les preuves et journaux d'exécution sont écrits dans les répertoires ignorés `target/`, `evidence/` et `fixture-profile/`, ou joints aux artefacts CI. Ils distinguent les environnements et les vérifications exécutées. La comparaison Solid/Rune, les mesures face à la TUI et les essais sur téléphone gardent leurs critères propres.
