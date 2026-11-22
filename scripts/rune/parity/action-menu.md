# Référence Solid du menu d'actions

```powershell
node scripts/rune/parity/action-menu.mjs
```

Le script monte le véritable `ActionOverflowMenu`, avec les styles globaux et le contexte compact de `FileRowActions`. Le cas `row` monte aussi le vrai `FileRowActions` et son observation de débordement. Seul le cadre de placement est synthétique. Les références restent sous `target/rune-parity/action-menu` : captures du menu et de son ombre, géométrie des lignes, arbre Chromium complet, snapshot accessible et traces de focus.

Avant de mesurer, la fixture attend le `translate3d` du positionneur Kobalte et trois rectangles consécutifs identiques après deux frames initiales. Elle exige aussi des rectangles identiques avant et après les captures intérieure et extérieure. Les positions restent calculées par Floating UI.

Les cas clair/sombre couvrent l'ouverture au clavier, le focus de la dernière action, survol, Échap, clic extérieur, actions désactivées/cochées, doublons, retrait/restauration des éléments et sélection normale ou immédiate. Les variantes de dialogue comparent la primitive Kobalte et le vrai `AlertDialog` via `showConfirmDialog`, au clavier et à la souris. Les noms et états finaux sont mesurés ; les écarts de comportement de la référence sont conservés dans le rapport.

Le navigateur est sans fenêtre. Toutes les requêtes restent sur le serveur Vite local ; seules les lectures API simulées sont permises. Chaque serveur possède son cache de fixture, fermé avant sa suppression. Le script ne lance aucun serveur de production, modèle ou commande externe.

Cette référence constitue une entrée de qualification. La comparaison Rune, les budgets régionaux de pixels, leurs contrôles négatifs, les revues indépendantes et les appareils physiques ont leurs propres preuves.

La galerie native se reproduit avec `node scripts/rune/parity/action-menu-native.mjs --binary <chemin-absolu-du-produit-test-support>`, puis `node scripts/rune/parity/compare-action-menu.mjs --thresholds scripts/rune/parity/action-menu-thresholds.json`. Le comparateur vérifie les empreintes, les rectangles réels et sept défauts délibérés : texte supprimé, premier libellé supprimé, texte déplacé d'un pixel, bordure, surbrillance et ombre supprimées, composant déplacé d'un pixel.

Les budgets revus exigent des bordures exactes, au plus un niveau RGBA d'écart sur surfaces et ombre, et un budget séparé pour le texte Segoe UI à 13 px. Les captures couvrent trois états courts à échelle 1 sous Windows. Le survol initial précède l'aide différée : Rune capture aussi cette aide séparément ; les PNG Chromium omettent les tooltips natifs `title`. Le déclencheur est comparé en géométrie. Sa rasterisation, les libellés longs, icônes, petits viewports, RTL, tactile et cycle complet des fenêtres appelantes restent à qualifier.
