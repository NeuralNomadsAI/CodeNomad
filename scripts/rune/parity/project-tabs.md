# Banc des onglets projet

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path target/rune-tools/playwright).Path
node --import tsx scripts/rune/parity/project-tabs.mjs
```

Le runner monte les vrais `InstanceTabs`, `InstanceTab` et `TabScroll`, avec les fournisseurs de préférences et i18n et `index.css`. Les trois fiches AST sont générées directement par `buildInventory`, enregistrées sous `target/rune-parity/project-tabs` et vérifiées contre les empreintes des sources. Le registre suivi reste inchangé. Les données projet sont synthétiques ; les appels API de configuration du navigateur reçoivent des réponses locales, sans serveur applicatif ou session OpenCode.

Huit contextes couvrent bureau, téléphone émulé, RTL hébreu et débordement, en clair/sombre. Chaque contexte capture la vraie barre en repos, survol et focus, son arbre accessible et ses styles calculés. Les contrôles réels sont exercés : sélection au clic/Entrée, fermeture par identité, New au clic/Entrée/Espace. La fermeture clavier est consignée indépendamment ; son échec reste un blocage d'accessibilité, même si le clic fonctionne. Aucun rendu de référence n'est réimplémenté, aucun contrôle du composant n'est masqué pour obtenir une ressemblance.

Le cache Vite appartient à la fixture via les helpers navigateur partagés, et son arrêt attend le drain avant suppression. Chromium est headless et tout accès hors du serveur loopback de la fixture est refusé.

## Raccord Rune

La galerie autonome `crates/rune-theme-codenomad/examples/project-tabs.rs` utilise `rune_theme_codenomad::tabs::strip`, avec descripteurs Alpha/Beta ou overflow, les mêmes langues/états et les entrées Runtime. Elle refuse de démarrer sans les deux options `--tree` et `--snap`. Aucun backend, profil utilisateur ou fenêtre native n'est ouvert. Les tests du thème couvrent aussi les vrais widgets, leur miroir web et le clavier EN/HE.

```powershell
cargo build --offline -p rune-theme-codenomad --example project-tabs
node --import tsx scripts/rune/parity/project-tabs.mjs --binary <chemin-absolu-project-tabs.exe>
```

Le runner reçoit le binaire déjà compilé, crée un environnement privé et transmet la géométrie exacte de chaque crop Solid à la scène Rune. Les arbres natifs vérifient les onglets sélectionnables et leurs fermetures ; les scripts séparés sélectionnent Beta, ferment Alpha par identité puis créent un onglet sélectionné. Les journaux, scripts, PNG et arbres complets restent dans le même dossier de preuve. Les captures restent brutes, sans ajustement du composant pour réduire une différence de pixels.

Les fichiers attendus pour une comparaison explicite sont `rune-<contexte>-<light|dark>-<rest|hover|focus>.png`, où contexte vaut desktop, phone-emulated, rtl ou overflow. Le runner exige un seuil revu fourni par l'appelant, puis utilise `scripts/rune/qualify-pixels.mjs` sur les deux vraies captures. Exemple à compléter après revue :

```text
node --import tsx scripts/rune/parity/project-tabs.mjs --rune-dir <captures-absolues> --max-diff-ratio <seuil-revu>
```

Une comparaison de pixels exige des crops de mêmes dimensions. Le crop Solid couvre `.tab-bar-instance` entier, y compris sa géométrie de scrollbar et ses actions ; le wrapper Rune actuel couvre seulement les onglets et New. La largeur intrinsèque/max Solid, ses icônes de dossier et d'état, ses bordures, sa voie supérieure de scrollbar, ses états hover/focus et les actions annexes nécessitent encore un raccord explicite. Les fonctionnalités rename, Temporary/remote, reorder, launcher New et badges restent des tranches distinctes de qualification. Le groupement tablist du miroir web Rune est suivi dans [Rune 1344](https://github.com/anomalyco/rune/issues/1344).

`evidence.json` reste un rapport de références Solid ou de captures appariées à examiner. La parité complète exige aussi accessibilité/entrées Rune, seuils examinés et deux revues indépendantes. Un téléphone émulé conserve le statut distinct des appareils physiques.
