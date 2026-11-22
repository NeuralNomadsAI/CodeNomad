# Référentiel Source du lecteur Workspace

Les scènes montent les vrais `FilesPreviewView`, `WorkspaceFileView`, `MonacoFileViewer`, leurs fournisseurs et le dialogue produit, avec `src/index.css`. Le runner emprunte une route au daemon canonique avec `borrowFixture`, possède son daemon et son SSE synthétique persistant, puis attend leur arrêt. Chromium est headless ; les API Files et les documents de configuration sont en mémoire. La sélection est observée dans le vrai modèle Monaco sans solliciter le presse-papiers.

Depuis la racine du worktree, avec les dépendances verrouillées déjà disponibles :

```powershell
node scripts/rune/parity/workspace-reader-sheet.mjs
node --import tsx scripts/rune/parity/workspace-reader.mjs --smoke
node --import tsx scripts/rune/parity/workspace-reader.mjs
```

`--smoke --scene mermaid` isole une scène. Le smoke standard couvre UTF-8/CRLF et fichier vide en clair/LTR/960. Le parcours complet couvre le socle UTF-8, vide, longue ligne, chargement retenu, erreur et binaire dans huit contextes : clair/sombre, anglais LTR/hébreu RTL et largeur 960/360, hauteur 640, échelle 1. BOM simple/double, UTF-8 malformé, `.md`, `.markdown`, `.mmd` valide/invalide, SVG et PNG majuscule sont capturés en clair/sombre LTR/960. Un parcours d’interaction vérifie la saisie clavier, le conflit Cancel/Overwrite avec expectedVersion et répertoire exact, le wrap, le défilement/sélection, la libération d’un chargement, la reprise d’erreur et la fermeture.

Le générateur écrit seulement `target/rune-parity/workspace-reader/sheets/` : trois fiches TypeScript checker (props, états, classes/tokens, chaînes et références), les helpers sans candidat JSX et `scene-inputs.json` (octets base64 communs au port Rune). L’index généré suivi reste intact. L’extraction statique indique des références de tests ; elle s’accompagne des interactions réellement exécutées par le runner.

Les PNG et `solid-evidence.json` sous `target/rune-parity/workspace-reader/` contiennent l’arbre AX natif Chromium, les snapshots ARIA, les rectangles et métriques CSS calculées du header/heading/titre/répertoire/boutons/contenu, la géométrie des SVG Source, les modèles/sélections/positions et les requêtes de fixture. Les empreintes incluent les composants Source, CSS consommées et les scripts de scène. Chaque sortie énumère ses propres captures ; les fichiers PNG laissés par un autre parcours ne constituent pas des résultats de cette sortie.

Les assets Monaco sont préparés dans `packages/ui/src/renderer/public/` du worktree exécutant le runner. Les dépendances partagées en junction restent en lecture. Pour Tiny, le serveur Vite peut servir les imports `?raw` d’une dépendance résolue hors racine comme des fichiers statiques. Le runner rétablit uniquement pour Tiny/LICENSE et Tiny/mermaid.tiny.js la transformation littérale `export default` de leurs octets installés ; leurs empreintes et les réponses adaptées sont enregistrées. Les composants, le moteur Tiny, le sandbox et les appels de rendu restent ceux de la Source.

## Portée de conversion

La référence garde le contrat final Workspace : source éditable, numéros de lignes et pliage, détection du langage, wrap/no-wrap, Save/hotkey/conflit/brouillons, Markdown/Mermaid et source, images et fallback binaire, lecteur central dont la durée de vie suit l’occurrence/session/worktree.

La qualification complète ajoute les formats JPEG/JPEG alias, GIF, WebP, BMP, ICO, AVIF, leurs contenus invalides/animations et limites de pixels, les liens/images Markdown et HTML, les bounds/reveal des grands documents, les transitions source/rendu avec position, l’IME et les commandes éditeur complètes. La fixture isolée ne qualifie pas le montage du shell, la suspension/reconnexion du propriétaire Rune, la conservation des brouillons entre remounts ni le corps sauvegardé par un véritable serveur. Les comparaisons Rune, leurs seuils régionaux, les contrôles négatifs et les cibles WASM/native sont des dépendances de la conversion. Aucun succès Source n’est assimilé à une parité Rune.
