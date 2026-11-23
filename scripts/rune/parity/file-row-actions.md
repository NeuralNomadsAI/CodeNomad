# File row actions

Le banc courant qualifie le contexte CSS nu. La fixture monte les vrais contrôles avec ConfigProvider/I18nProvider. Le contrôle privé du vrai ThemeProvider mesure un tracking hérité de 0,15008px, un texte example.rs élargi de 1,5px, une bascule de compaction à largeur167 et les palettes appliquées par défaut. La fondation Source commune avec provider précède la qualification du contexte produit et l'adoption de budgets.

Le module thème `file_row_actions` assemble les boutons épinglés, les secondaires inline et le menu partagé. `Actions::new(Menu)` partitionne les items par `checked.is_some()` ; `checked: Some(false)` reste épinglé. Les items et callbacks restent des `Rc<action_menu::Item<S>>` fournis et mémorisés par l'owner.

`State` garde la compaction et les états de survol/focus nécessaires au rendu. `sync` reçoit le budget de la ligne complète et le `Tx` courant, préserve un menu ouvert pendant resize et migre le focus secondaire/trigger lors d'une bascule. Une fermeture de menu attend le retour de focus avant de développer les actions. Le caller conserve l'état hors des lignes virtualisées et appelle les fonctions `sync`, `clear` et `poll` du menu partagé à leurs moments habituels.

```rust
let actions = Rc::new(file_row_actions::Actions::new(menu));
file_row_actions::sync(&mut row_state, &actions, menu_open, budget, tx);
let (group, popup) = file_row_actions::view(
    &row_state, row_state_at, &menus, menu_state_at, actions,
    Visibility { coarse_pointer, focus_within }, viewport_width,
);
```

Le parent utilise `hover_group()` pour son survol de ligne. `Visibility::focus_within` comprend le focus au pointeur et programmatique, et `coarse_pointer` correspond exactement à la capacité Source `(pointer: coarse)`. Ces booléens appartiennent à l'owner/plateforme. Le menu ouvert et un toggle actif révèlent également les boutons.

`natural_width` correspond au calcul Source qui ignore le trigger et les groupes de largeur nulle. Sa valeur peut différer de la boîte Flex réelle : une unique secondaire dans deux spans présents donne un budget de 24px et une boîte de 26px. Le parent ajoute son texte naturel (`rune::text::measure(..., None)`), ses autres enfants et ses propres pads/gaps. Le texte tronqué et le groupe compact ne servent jamais de mesure naturelle. Une lecture `Cx::layout_size` évite une notification par frame de scroll ; une observation de layout doit distinguer largeur demandée et largeur observée.

Les boutons réutilisent `Button::label_with` avec les éléments d'icônes des items, les métriques Source 24/14 et le contour interne. Les secondaires compactes restent montées et mesurables, en absolu, transparentes, inert et cachées à l'accessibilité. Le groupe consomme aussi les clics dans les gaps. Le popup est rendu dans le layer `rune_kit::root`, hors du groupe inert.

Les métriques proviennent du CSS réellement calculé. La tolérance 0.5 est extraite de l'AST `row-compact-actions.ts`. Les deux fonds actifs sont lus par Chromium après un vrai survol ; la cascade et les règles `!important` restent celles du navigateur. Le test de génération comprend deux règles hover `!important`, la plus spécifique placée avant la moins spécifique.

## Vérification native acquise

Dix tests Runtime couvrent les toggles false épinglés, la mesure des groupes vides, les clics de gap, disabled, la tolérance de compaction, l'inertie et l'accessibilité des secondaires masquées, la migration de focus, les activations uniques Enter/Espace et le menu ouvert pendant resize. Une reproduction utilisant seulement les APIs publiques de Rune montre que `hover_group` révèle ses descendants avec focus clavier et les masque avec focus sans ring hors du groupe ; les booléens explicites de visibilité complètent ce comportement Source.

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_TARGET_DIR='D:/CodeNomad/.codenomad/worktrees/rune-native-chat/packages/rune-chat/target'
cargo +1.99.1 test -p rune-theme-codenomad --lib --offline --locked
cargo +1.99.1 fmt -p rune-theme-codenomad --check
node scripts/rune/generate-theme.mjs --check
node --test scripts/rune/generate-theme.test.mjs
```

## Qualification Source en cours

La fixture `packages/ui/tests/browser/fixtures/file-row-actions.tsx` monte les vrais `FileRowActions` et `ActionOverflowMenu`. Tous les callbacks se limitent à des traces privées. Les requêtes sont restreintes au serveur de fixture loopback et aux lectures ; aucune ouverture native ou opération de presse-papiers n'est exposée.

`file-row-actions-pointer.mjs` isole le trigger seul puis entouré de FileRowActions, avec capture/bubble pointerdown/up/click/focus, mutations expanded/montage, boîtes, styles et hit target. Il conserve le prélude capture, focus inline, resize puis capture. Le banc `file-row-actions.mjs` exige le clic pointeur, puis le retour de focus après fermeture. Les deux réutilisent la fixture Solid du daemon navigateur partagé.

```powershell
node --import tsx scripts/rune/parity/file-row-actions-pointer.mjs
node --import tsx scripts/rune/parity/file-row-actions.mjs
```

Les preuves et captures restent sous `target/rune-parity/file-row-actions*`. Les tests des callers réels, les interactions tactiles/hybrides, le mouvement, le clipping et les budgets régionaux gardent leurs qualifications propres. Aucun seuil visuel n'est adopté pour ce composant.

La galerie offscreen est compilée par `cargo +1.99.1 build --offline --locked -p rune-theme-codenomad --example file-row-actions`, dans le cache prescrit. `file-row-actions-native.mjs --binary <chemin-absolu>` exige 24 états stabilisés, le focus attendu et l'ouverture au pointeur. `file-row-actions-measure.mjs` compare la géométrie réellement capturée et mesure séparément glyphes, contours, surfaces et gaps. La précision des couleurs actives calculées en Oklab reste à porter au-delà de l'extraction hex8 ; les mesures gardent le statut measurements-only.
