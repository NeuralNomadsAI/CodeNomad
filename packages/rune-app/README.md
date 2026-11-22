# Application Rune

Le client natif et WebAssembly utilise le même état et les mêmes écrans. Le contrat HTTP/SSE, la pagination et la reprise sont dans `crates/codenomad-client`. Le thème et les dix catalogues sont générés depuis les sources Solid dans `crates/rune-theme-codenomad`.

Les conventions, correspondances et critères de qualification sont dans [RUNE.md](../../dev-docs/RUNE.md). Le contrat navigateur et les essais mobiles sont détaillés dans [RUNE_WEB.md](../../dev-docs/RUNE_WEB.md).

## Construire

Depuis ce worktree isolé, définir `CARGO_TARGET_DIR` vers le cache Cargo existant avant toute compilation :

```powershell
./packages/rune-app/setup.ps1
cargo +1.99.1 test --locked --workspace
cargo +1.99.1 run --locked -p rune-style-policy -- packages/rune-app/src
cargo +1.99.1 build --locked --target wasm32-unknown-unknown -p codenomad-rune-app --bin codenomad-rune
```

Le binaire natif est `$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe` sous Windows. La préparation vérifie la révision Rune épinglée dans le manifeste et la propreté de sa dépendance. Le verrou Cargo appartient à la racine du workspace.

## Ouvrir une conversation

Le lanceur propose l'adresse et l'authentification du serveur, l'ouverture d'un dossier, ses sessions et la création d'une session. Les identifiants sont résolus par le client. La liste demande 200 sessions par page et filtre les titres chargés. Un brouillon ou une demande en cours bloque la navigation ; une création dont la réponse est incertaine exige une actualisation avant nouvel essai.

Entrée envoie, Maj+Entrée insère une ligne. Le fil conserve l'ancre pendant le chargement de messages précédents et la reprise. Les blocs d'outils affichent état, entrée et sortie consultables. Les contrôles d'agent proposent modèle et variante, réponses aux permissions et questions, et interruption.

Le client demande au plus 200 messages par page et borne la fenêtre résidente à 2 048 messages et 8 Mio ; une réponse HTTP est limitée à 2 Mio. Atteindre une limite conserve un état d'erreur explicite. La scène synthétique de 10 000 messages qualifie séparément le moteur de rendu.

Le navigateur utilise son origine et les cookies de cette origine. Le dossier désigne le système de fichiers du serveur. Les chemins absolus Windows et POSIX sont traités selon leur forme serveur.

## Serveur enfant isolé

Le mode natif explicite lance un serveur possédé par Rune si ces trois paramètres sont fournis :

- `RUNE_SERVER_BIN` : chemin absolu du binaire `codenomad-rs`.
- `RUNE_HOST_ROOT` : chemin absolu d'un dossier neuf pour le profil isolé.
- `CODENOMAD_PROFILE` : nom `trial-*`.

`RUNE_BACKEND` sélectionne un serveur externe et prend priorité sur ce mode. Le propriétaire du processus réalise l'authentification bootstrap et l'arrêt sur son worker. La fermeture de la boucle Rune attend sa terminaison. Le navigateur publie le lancement local comme indisponible.

## Vérifications sans fenêtre

```powershell
$env:RUNE_CLIENT_EXE = "$env:CARGO_TARGET_DIR/debug/codenomad-rune.exe"
$env:RUNE_SERVER_EXE = 'D:/chemin/worktree-serveur/packages/server-rs/target/debug/codenomad-rs.exe'
node packages/rune-app/fixture.mjs --probe-contract
node packages/rune-app/launcher-fixture.mjs
node packages/rune-app/launcher-fixture.mjs --uncertain-create
node packages/rune-app/launcher-fixture.mjs --with-tools
node packages/rune-app/launcher-fixture.mjs --controls
node packages/rune-app/recovery-fixture.mjs
node scripts/rune/headless.mjs --binary $env:RUNE_CLIENT_EXE
```

Les fixtures créent leurs projets, profils `trial-*`, ports éphémères et processus ; OpenCode est simulé dans ces scénarios. Le serveur Rust reste réel. `RUNE_CLIENT_EXE` et `RUNE_SERVER_EXE` sélectionnent des exécutables absolus ; le client utilise sinon le cache `CARGO_TARGET_DIR`, ou `target` à la racine du workspace.

`controls-live.mjs` et les scripts `real-history-*` sont des essais explicites avec un OpenCode réel déjà configuré, des sessions jetables et des outils interdits. `interactive-live.mjs` ouvre une fenêtre et demande un dossier et un titre exacts ; ses essais utilisent une copie de la conversation source. Leur lancement interactif appartient à une qualification dédiée.

Les preuves sont écrites dans les répertoires ignorés `target/`, `evidence/` et `fixture-profile/`. Le journal distingue les environnements et les vérifications exécutées. La comparaison Solid/Rune, les mesures face à la TUI et les essais sur téléphone gardent leurs critères propres.
