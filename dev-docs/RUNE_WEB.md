# Rune dans le navigateur

## Contrat partagé

Le client, l'état et les écrans de `packages/rune-app` ciblent le bureau et `wasm32-unknown-unknown`. Les requêtes et l'attente des événements sont asynchrones. Le navigateur utilise son origine et son magasin de cookies pour retrouver le serveur ; l'accès distant conserve les contrats HTTPS et d'appairage CodeNomad.

`codenomad-rs serve --ui-dir <bundle>` publie le bundle Rune sur son listener HTTPS direct. Un appareil appairé charge la page, le WASM, les scripts et les polices sur la même origine que les API. L'entrée `/` guide les appareils sans cookie vers l'appairage. L'origine directe doit être admissible et le certificat vérifié par le téléphone. Le transport OpenTunnel est porté par le serveur TypeScript.

Les capacités du bureau sont isolées par la plateforme. La sélection d'un dossier serveur conserve un chemin explicite sur le web. Le lancement d'un processus local appartient à l'hôte bureau. Les fonctions de fenêtres multiples, de fichiers, de notifications et de presse-papiers publient leurs capacités disponibles avant d'être proposées.

La page d'appairage embarque le thème et les dix catalogues ; le code à usage unique disparaît du fragment avant l'échange HTTPS. En cas de rupture du flux, le client sonde le statut d'authentification. Une réponse `pairingRequired` présente les étapes d'appairage sans remplacer le document ni le brouillon. Le bouton de vérification ou le retour au premier plan relit le statut ; la reprise relit l'historique sur la même conversation.

La liste de sessions publie la première page du dossier puis enrichit automatiquement la liste en suivant les curseurs des worktrees déclarés. Chaque curseur appartient à son dossier. La recherche interroge les mêmes dossiers indépendamment des pages affichées ; changer de projet ou de requête annule la recherche précédente.

Après une rupture SSE et un historique indisponible, l'inventaire authentifié confirme l'absence de l'occurrence. Le navigateur revalide l'identité du serveur, ouvre le même dossier dans une nouvelle occurrence et relie la session native exacte. Il garde le document et le brouillon et relit l'historique sans réémettre d'action. Le catalogue ordinaire est rechargé même lorsque la recherche reste ouverte.

## Risques à qualifier

La révision Rune est celle épinglée dans le manifeste de l'application. Les références suivantes décrivent les mécanismes présents dans ses sources. La qualification utilisateur exige les essais indiqués dans la dernière colonne.

| Risque | Mécanisme Rune inspecté | Qualification nécessaire |
|---|---|---|
| Clavier mobile et IME | `crates/rune/src/platform/web/bridge.js` crée un `textarea` DOM, écoute `input` et les événements de composition | Téléphones Android et iOS : focus, ouverture/fermeture du clavier, composition, correction, dictée, maintien du brouillon et sélection |
| Accessibilité | Le même adaptateur construit un miroir DOM avec boutons et événements d'activation dans `syncA11y` | Parcours lecteur d'écran, ordre de lecture, focus, rôles, états, annonces du streaming et demandes de permission |
| Surface utile du téléphone | `platform/web/platform.js` observe `visualViewport` et les zones sûres ; `platform/web.rs` expose les caractéristiques du pointeur | Portrait et paysage, clavier ouvert, barre du navigateur, encoche, zoom et changement de taille |
| Défilement tactile | Adaptateurs de pointeur et conteneurs de défilement DOM | Lecture pendant le streaming, inertie, sélection, retour au bas, pagination avec ancre conservée sur un historique long |
| Chargement et poids | Cible Rune WebAssembly et initialisation graphique asynchrone | Taille brute et compressée de chaque ressource, réseau à débit limité, démarrage à froid et à chaud, premier contenu utile |
| Performances et consommation | Boucle web monothread avec rendu piloté par la demande | Téléphone physique : temps de trame, réactivité pendant le streaming, mémoire, chauffe et consommation sur une durée représentative |
| Fonctions d'hôte | Adaptateur web Rune et frontière de plateforme CodeNomad | État des capacités, navigation et erreurs actionnables pour les fonctions indisponibles |

Chaque défaut reçoit une reproduction minimale et une attribution : adaptation CodeNomad lorsqu'elle possède le contrat concerné, issue Rune lorsque le défaut se reproduit dans une scène Rune isolée. Les mesures de navigateur avec émulation et celles sur appareil physique sont conservées séparément dans les preuves.

Les onglets CodeNomad assemblent un bouton de sélection et un bouton de fermeture frères : leurs rôles et états restent présents dans le miroir web. Le regroupement `tablist` nécessite une évolution Rune, suivie dans [l'issue 1344](https://github.com/anomalyco/rune/issues/1344), avec reproduction autonome des onglets fermables et du conteneur. Le parcours lecteur d'écran complet conserve sa qualification propre.

Le miroir web omet aussi le conteneur `menu`, les entrées désactivées du Menu kit et l'état désactivé des boutons. L'arbre accessible natif porte ces rôles et états. Le contrat du miroir est suivi dans [l'issue 118](https://github.com/anomalyco/rune/issues/118#issuecomment-7076114863), avec une reproduction publique Rune/rune-kit et observation du DOM WebAssembly. Les interactions au clavier passent par le canvas et son descendant actif ; les boutons du miroir servent aux actions assistives.

## Vérifications reproductibles

Le bundle produit est qualifié avec le vrai serveur Rust et OpenCode simulé : connexion avec cookies, deux pages de sessions, historique exact, session vide puis retour, et refus 401 sans cookie. Le smoke mobile vérifie le toucher au centre, l'IME, le redimensionnement, un message visible uniquement via SSE, la récupération d'un message absent pendant la coupure et la conservation du brouillon après révocation et réappairage. Sur l'émulateur Android, `interactive-widget=resizes-content` fait redimensionner le viewport de mise en page à l'ouverture de Gboard. Les commandes et limites du banc sont dans [Coquille web Rune](../scripts/rune/web-README.md).

Depuis le worktree isolé, avec le `CARGO_TARGET_DIR` existant :

```powershell
rustup target add --toolchain 1.99.1 wasm32-unknown-unknown
cargo +1.99.1 build --locked --target wasm32-unknown-unknown -p codenomad-client -p rune-theme-codenomad
cargo +1.99.1 check --locked --target wasm32-unknown-unknown -p codenomad-rune-app
```

La compilation des cibles précède la qualification de la coquille servie par le serveur. Celle-ci couvre connexion, liste des sessions et lecture avec le même code d'état et de vues. Le parcours complet sur téléphone ajoute écriture, permissions, questions et arrêt via l'accès distant, puis les notifications push.
