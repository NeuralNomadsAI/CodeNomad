# Banc des onglets projet

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path target/rune-tools/playwright).Path
node --import tsx scripts/rune/parity/project-tabs.mjs
```

Le runner monte les vrais `InstanceTabs`, `InstanceTab` et `TabScroll`, avec les fournisseurs de préférences et i18n et `index.css`. Les trois fiches AST sont générées directement par `buildInventory`, enregistrées sous `target/rune-parity/project-tabs` et vérifiées contre les empreintes des sources. Le registre suivi reste inchangé. Les données projet sont synthétiques ; les appels API de configuration du navigateur reçoivent des réponses locales, sans serveur applicatif ou session OpenCode.

Dix contextes couvrent bureau, téléphone émulé, RTL hébreu, Alpha inactif et débordement, en clair/sombre. Chaque contexte capture la vraie barre en repos, survol, survol de fermeture et focus, son arbre accessible et ses styles calculés. Les huit contextes hors débordement capturent aussi le périmètre exact du vrai `InstanceTab` Alpha, fermeture comprise. Les contrôles réels sont exercés : sélection au clic/Entrée, fermeture par identité, New au clic/Entrée/Espace. La fermeture clavier est consignée indépendamment ; son échec reste un blocage d'accessibilité, même si le clic fonctionne. Aucun rendu de référence n'est réimplémenté, aucun contrôle du composant n'est masqué pour obtenir une ressemblance.

Le cache Vite appartient à la fixture via les helpers navigateur partagés, et son arrêt attend le drain avant suppression. Chromium est headless et tout accès hors du serveur loopback de la fixture est refusé.

## Raccord Rune

La galerie autonome `crates/rune-theme-codenomad/examples/project-tabs.rs` utilise les composants publics `rune_theme_codenomad::tabs::{strip,tab}`, avec descripteurs Alpha/Beta ou overflow, les mêmes langues/états et les entrées Runtime. Elle refuse de démarrer sans les deux options `--tree` et `--snap`. Aucun backend, profil utilisateur ou fenêtre native n'est ouvert. Les tests du thème couvrent aussi les vrais widgets, leur miroir web et le clavier EN/HE.

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
$env:CARGO_INCREMENTAL = '0'
cargo +1.99.1 build --offline -p rune-theme-codenomad --example project-tabs
node --import tsx scripts/rune/parity/project-tabs.mjs --binary <chemin-absolu-project-tabs.exe>
```

Le runner reçoit le binaire déjà compilé, crée un environnement privé et transmet la géométrie exacte de chaque crop Solid à la scène Rune. Les arbres natifs vérifient les onglets sélectionnables et leurs fermetures ; les scripts séparés sélectionnent Beta, ferment Alpha par identité puis créent un onglet sélectionné. Les journaux, scripts, PNG et arbres complets restent dans le même dossier de preuve. Les captures restent brutes, sans ajustement du composant pour réduire une différence de pixels.

Les fichiers attendus pour une comparaison explicite sont `rune-<contexte>-<light|dark>-<rest|hover|close-hover|focus>.png`, où contexte vaut desktop, phone-emulated, rtl, inactive ou overflow. Les captures de primitive portent le préfixe `rune-alpha-` / `solid-alpha-`. Le runner exige un seuil revu fourni par l'appelant, puis utilise `scripts/rune/qualify-pixels.mjs` sur les deux vraies captures. Le seuil Alpha est indépendant du seuil de barre complète. Exemple à compléter après revue :

```text
node --import tsx scripts/rune/parity/project-tabs.mjs --rune-dir <captures-absolues> --max-diff-ratio <seuil-revu>
node --import tsx scripts/rune/parity/project-tabs.mjs --binary <exemple-absolu> --max-alpha-diff-ratio <seuil-primitive-revu>
```

Une comparaison de pixels exige des crops de mêmes dimensions. Le crop Solid couvre `.tab-bar-instance` entier, y compris sa géométrie de scrollbar et ses actions ; le wrapper Rune couvre les onglets et New. La primitive Alpha réutilise les métriques CSS générées : largeur intrinsèque et maximum, hauteur, espacement, bordures, icône FolderOpen et fermeture Lucide partagée. Les captures exposent les différences de rastérisation du texte/SVG, de focus et de bordures. La voie supérieure de scrollbar et les actions annexes restent à porter avant qualification de la barre entière. Les fonctionnalités rename, Temporary/remote, reorder, launcher New et badges restent des tranches distinctes de qualification. Le groupement tablist du miroir web Rune est suivi dans [Rune 1344](https://github.com/anomalyco/rune/issues/1344).

`--reuse-solid --binary <exemple-absolu>` réemploie les références présentes après vérification des empreintes AST des trois composants, des quarante états et des PNG. Cette option permet de renouveler seulement les captures Rune avec des références Solid inchangées ; la provenance du rapport réemployé reste dans `evidence.json`.

`evidence.json` reste un rapport de références Solid ou de captures appariées à examiner. La parité complète exige aussi accessibilité/entrées Rune, seuils examinés et deux revues indépendantes. Un téléphone émulé conserve le statut distinct des appareils physiques.
