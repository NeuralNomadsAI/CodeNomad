# Application Rune native et web

## Périmètre et architecture

`packages/rune-app` contient l'application native, son état et ses vues. `crates/codenomad-client` contient le contrat typé CodeNomad, les requêtes HTTP, les événements SSE, la pagination et la reprise. Le client reçoit explicitement l'adresse, l'authentification et son propriétaire de réveil ; la sélection du profil et le rendu appartiennent à l'application.

Les modules applicatifs sont groupés par domaine : `agent/`, `launcher/`, `chat/`, `components/` et `platform/`. Les sondes CLI et scènes synthétiques sont activées explicitement par la feature `test-support` ; les artefacts produit natif et WebAssembly conservent les entrées simulées et l'inspection du moteur Rune.

`crates/rune-theme-codenomad` reçoit les valeurs générées depuis les styles Solid et les dix catalogues existants. `crates/codenomad-host-process` isole les primitives de confinement de processus derrière une API sûre. L'application conserve l'interdiction du code `unsafe`.

Rune est épinglé à la révision déclarée dans le manifeste de l'application. La préparation vérifie cette identité et l'absence de modifications du checkout de dépendance. Une mise à jour est explicite et qualifiée sur les plateformes prises en charge. Les défauts upstream font l'objet d'une issue dans le dépôt Rune.

## Agent conventions

- Privilégier le style compact du Rust de Tauri : garder une vue d'ensemble du domaine, limiter fichiers, indirections et commentaires, et concentrer les tests sur les contrats et risques réels. Une expression plus dense convient lorsqu'elle évite une abstraction bavarde et reste lisible.
- L'intégration se fait sur `feat/rust-server`, par branches courtes issues de sa dernière version distante. La synchronisation avec `dev` reste propriétaire de ses fusions ; une tranche Rune ne fusionne jamais `dev` elle-même.
- Garder le checkout principal, les hôtes installés, leurs profils et le daemon OpenCode partagé hors des écritures de développement. Les essais utilisent des profils `trial-*`, des sessions et répertoires propres et les caches Cargo existants.
- Les écrans assemblent des composants `rune-kit` ou des composants CodeNomad partagés. Les besoins spécifiques deviennent des variantes ou options de ces composants ; la logique et les transitions restent dans l'état.
- Couleurs, dimensions, rayons, espacements, typographies et animations proviennent du thème généré. Les adaptateurs de géométrie consomment des jetons sémantiques. Les générateurs et le contrôle de styles doivent couvrir aussi les alias, macros et expressions indirectes avant de qualifier leur garde-fou.
- Chaque texte visible provient des catalogues Solid générés. Préserver les remplacements de paramètres, les variantes de pluriel, le fallback anglais et le sens de lecture de l'hébreu. Une langue reste une sélection d'état explicite.
- Les rôles, noms, valeurs et états sont vérifiés dans le véritable arbre d'accessibilité Rune ; les interactions de test passent par ses entrées simulées.
- Convertir le comportement et le rendu Solid avant de simplifier. Les tests et fixtures Solid sont les exigences de référence ; une correspondance de noms ou une capture isolée reste une référence de source jusqu'à comparaison exécutée.
- Deux relecteurs indépendants examinent l'état courant sans historique des corrections. Tout constat bloquant ou moyen nécessite une preuve par test. La fusion attend leur résolution ; les constats mineurs restent consignés.
- Chaque composant qualifié possède une fiche générée, une scène de galerie, des comparaisons claire et sombre avec seuil explicite, une référence d'accessibilité et des interactions simulées.
- Supprimer un module Solid et ses raccords Tauri seulement après qualification de l'ensemble de son jumeau Rune. La table de correspondance conserve la provenance de chaque module ; les changements synchronisés de la source déclenchent l'adaptation et la requalification de ce jumeau.
- Les besoins de vue web et de terminal PTY reçoivent une note de décision avant implémentation.
- Chaque tranche compile le client, l'état et les mêmes écrans en natif et pour `wasm32-unknown-unknown`. La CI vérifie les deux cibles.
- Le client utilise des opérations asynchrones et des transports interchangeables : HTTP/SSE natif et `fetch`/`EventSource` avec les cookies du navigateur. Les fils bloquants et le client HTTP bloquant restent hors du code partagé.
- Les services propres au bureau passent par l'interface de plateforme : serveur enfant, fichiers locaux, notifications, presse-papiers et fenêtres. Chaque capacité possède une implémentation navigateur ou un état d'indisponibilité explicite.
- Les mises en page et les interactions sont qualifiées sur téléphone portrait, tablette et bureau, avec entrées tactiles.

## Cible web et mobile

L'application partagée cible WebAssembly et s'appuie sur les contrats d'accès distant HTTPS et d'appairage existants. La coquille web est servie comme fichiers statiques par `codenomad-rs` ; son parcours de qualification couvre connexion, liste des sessions et lecture d'une conversation, puis écriture, permissions, questions et arrêt.

Le rapport de risques distingue les capacités observées dans les sources Rune, les essais de navigateur automatisés et les essais sur téléphone physique. Il couvre clavier virtuel, IME, correction et dictée, lecteurs d'écran, taille compressée et temps de chargement, performances, consommation et défilement tactile. Chaque problème est attribué à l'adaptation CodeNomad ou à une issue Rune étayée par une reproduction. Les notifications push et la parité web complète complètent le jalon conversation mobile.

Les mécanismes inspectés et les critères d'essai sont détaillés dans [Rune web et mobile](RUNE_WEB.md).

## Inventaire et correspondances

L'index tracé `rune-components.generated.json` conserve identités, correspondances, statuts et empreintes des fiches. Les fiches complètes sont reproduites sous `target/rune-inventory/`, dans les sorties ignorées. Leurs références de tests et usages sont des liens statiques vers les sources analysées. Le statut de conversion reste indépendant de cette découverte.

| Domaine | Sources Solid / hôte | Cible Rune | État |
|---|---|---|---|
| Contrat HTTP, SSE et reprise | API CodeNomad et fixtures de contrat | `crates/codenomad-client` | Tests natifs, fenêtre de 606 lignes et compilation WASM vérifiés ; parcours connecté web à qualifier |
| Jetons et typographie | `packages/ui/src/styles/tokens.css`, styles partagés | `crates/rune-theme-codenomad` | Génération et géométrie à qualifier |
| Textes | `packages/ui/src/lib/i18n/messages/` | Catalogues générés consommés par le thème et l'application | Dix catalogues, fallback et sens hébreu vérifiés |
| Contrôles partagés | Contrôles Solid et leurs fixtures | `rune-kit` et variantes CodeNomad | Inventaire ; parité à qualifier |
| Fermeture de fenêtre | `components/window-close-button.tsx` | `packages/rune-app/src/components/window_close_button.rs`, adaptateur `window_control` du thème et galerie | Six paires Windows à échelle 1, accessibilité et activations vérifiées ; autres plateformes et échelles à qualifier |
| Démarrage du serveur | `packages/tauri-app/src-tauri/src/cli_manager.rs` | Hôte enfant de `packages/rune-app` | Bootstrap, génération et arrêt Windows vérifiés en profil isolé ; lancement quotidien à compléter |
| Fil, composeur et ouverture de session | Fixtures du fil, du composeur et des projets | Vues et état de `packages/rune-app` | Parcours natif avec serveur partagé et OpenCode simulé vérifié ; parité Solid à qualifier |
| Client navigateur | Contrats d'accès distant et cible web Rune | Même état et mêmes vues WASM, bundle servi par `codenomad-rs` | Scène locale sur trois viewports vérifiée ; lecture de session connectée et téléphone physique à qualifier |

## Qualification et intégration

La qualification distingue la structure compilée, les contrats de données, les interactions natives, l'accessibilité et la parité visuelle. Une réussite dans une catégorie porte uniquement sur les cas réellement exécutés. Les captures et preuves volumineuses restent dans les sorties ignorées ; les références nécessaires et les scénarios reproductibles sont tracés.

Les vérifications automatiques restent sans fenêtre visible ni prise de focus. Les essais OpenCode réels utilisent des sessions jetables et interdisent les outils sauf nécessité explicite du cas. Le garde-fou de latence reprend les marqueurs et mesures du banc `scripts/perf/` face à la TUI.

Les jalons sont les fondations, l'alpha interne permettant une journée de travail, la parité complète et la bascule publiée. La suppression des hôtes Solid/Tauri et du serveur TypeScript appartient à la bascule, après qualification des fonctionnalités et plateformes.

## Mise à jour et passage à Rune

La bascule publiée exige un module de mise à jour Rust utilisant le flux et la clé publique de signature du contrat [Tauri updater](TAURI_UPDATER.md). La sélection stable/preview, la version portée par le commentaire signé, la vérification complète du téléchargement, la sauvegarde de l'état et l'arrêt confirmé du serveur possédé font partie des critères d'admission. La qualification couvre aussi le retour arrière et la conservation des données.

Les installations Windows, macOS et Linux doivent être testées séparément. La dernière application Tauri doit pouvoir admettre et installer le premier paquet Rune par son mécanisme de mise à jour, avec conservation de l'identité de l'application et des raccourcis. Les mécanismes applicables de `packages/server-rs/install/` sont à réutiliser. Une incompatibilité d'installation reçoit une note de décision avant la bascule.

Les essais d'installation et de migration utilisent des systèmes et profils jetables. Les clés privées de production restent réservées aux étapes de signature de publication ; les essais emploient leurs clés propres. Le module de mise à jour appartient à la plateforme bureau. La distribution du client web suit les actifs statiques servis et les contrats d'accès distant.
