# Frontière des styles Rune

Depuis la racine du workspace :

```powershell
cargo test -p rune-style-policy --locked
cargo run -p rune-style-policy --locked -- packages/rune-app/src
```

Le contrôle parse récursivement tous les fichiers Rust de l'application avec `syn`, y compris les sondes et tests. Les méthodes visuelles de Rune sont refusées indépendamment de leurs arguments : un littéral, un alias et un calcul ont le même traitement. Les appels UFCS, pointeurs de fonction, imports renommés, types visuels publics, configurations visuelles `AppSpec` et mutations des champs de fenêtre passent aussi par le contrôle. Les appels de composants `rune-kit` se placent dans l'adaptateur du thème partagé.

Les constructeurs de dimensions restent privés dans le thème. L'application reçoit des rôles et des variantes : `Space`, `TextRole` et les méthodes sémantiques de `layout::Layout`. Les extensions partagées construisent des éléments Rune et résolvent les métriques CSS générées. Les viewports et coordonnées d'entrées des tests restent des données explicites des fixtures.

Les macros d'expressions admises appartiennent à une liste fermée ; leurs arguments sont visités comme expressions ou jetons imbriqués. Les définitions de macros, attributs procéduraux, dérivations supplémentaires et modules externes via `#[path]` exigent une extension revue de cette politique. Le manifeste classe les méthodes publiques explicites de chaque implémentation `El` trouvée récursivement dans ses modules à la révision Rune épinglée. Les accès imbriqués aux dimensions et familles d'une configuration de fenêtre sont également contrôlés.

Les macros `std::pin::pin!` et `core::pin::pin!` conservent la même analyse de leurs arguments ; les formes non qualifiées ou provenant d'autres modules demandent leur propre admission.

Cette analyse syntaxique est conservatrice : un nom de méthode visuelle peut être refusé sur un autre type. Les dépendances approuvées, la génération du thème et les API du thème font partie de la frontière de confiance et demandent une revue quand elles évoluent. Un contrôle des styles ne qualifie pas le rendu : les assemblages du lanceur, du fil, du composeur et des contrôles de l'agent nécessitent leurs comparaisons d'images, d'accessibilité et d'interaction.
