# Raccourcis clavier

## Découvrir les commandes et ouvrir l’aide {#discover-commands}

1. Ouvrez **Palette de commandes** avec `Ctrl+Shift+P` sous Windows/Linux ou `Cmd+Shift+P` sous macOS, ou utilisez son bouton/entrée de menu visible.
2. Tapez un nom d’action. La palette inclut les actions de l’application et les commandes personnalisées de la Location actuelle ; leur disponibilité dépend de la vue active.
3. Exécutez **Ouvrir l’aide** pour ouvrir ce guide dans la langue actuelle de l’interface, dans un contexte de navigateur externe. Le menu natif **Aide → Aide de CodeNomad** ouvre le même guide.

L’aide laisse la vue et le brouillon intacts. Si l’ouverture échoue, visitez directement [Aide CodeNomad](https://neuralnomadsai.github.io/CodeNomad/). Une commande découvrable n’a pas nécessairement un raccourci personnalisable : le gestionnaire couvre un catalogue fixe de 49 commandes du moteur de rendu, pas toutes les actions de palette ou de menu natif.

## Enregistrer, désactiver et réinitialiser {#customize}

1. Ouvrez **Paramètres → Raccourcis clavier** et utilisez **Filtrer les raccourcis** pour trouver l’action.
2. Choisissez **Modifier**, puis appuyez sur la combinaison voulue dans **Appuyez sur une combinaison de touches**. La capture enregistre cette affectation.
3. Utilisez **Désactiver** pour retirer l’affectation de cette action du moteur de rendu, **Réinitialiser** pour sa valeur par défaut, ou **Tout réinitialiser** pour toutes les affectations du moteur de rendu.
4. Résolvez les avertissements de chaque ligne en conflit ; les conflits sont signalés, pas désactivés silencieusement.

Les affectations sont enregistrées dans la configuration d’interface CodeNomad et affectent les clients qui la partagent. Elles ne modifient pas les raccourcis CLI/TUI d’OpenCode ni les accélérateurs de menu natif. La capture suspend les raccourcis du moteur de rendu, mais ne peut pas suspendre ceux du système ou du menu natif. **Annuler**, la perte de focus, la fermeture de la section ou la sortie de la fenêtre termine la capture. Les modificateurs seuls et la composition IME sont ignorés ; Tab/Shift+Tab simple déplace le focus.

Si l’enregistrement échoue, gardez l’ancien raccourci disponible et réessayez après vérification de l’affectation affichée. Réinitialiser est le moyen sûr de corriger une affectation accidentelle.

## Valeurs par défaut du moteur de rendu {#renderer-defaults}

`Mod` désigne `Ctrl` sous Windows/Linux et `Cmd` sous macOS. Ce sont des valeurs par défaut, pas des garanties que le système/l’hôte natif transmettra la touche. La portée compte : une même touche peut servir une autre action sur l’accueil, dans la zone de saisie ou la recherche.

| Action | Valeur par défaut |
| --- | --- |
| Ouvrir la palette de commandes | `Mod+Shift+P` |
| Nouvelle instance / Parcourir les dossiers sur l’accueil | `Mod+N` |
| Fermer l’onglet de l’application | `Mod+W` |
| Onglet d’application précédent / suivant | `Mod+[` / `Mod+]` |
| Onglet d’application 1–9 | `Mod+1` à `Mod+9` |
| Renommer l’instance (contexte d’onglet) | `F2` |
| Nouvelle session | `Mod+Shift+N` |
| Fermer la session | `Mod+Shift+W` |
| Session précédente / suivante | `Mod+Shift+[` / `Mod+Shift+]` |
| Onglet de session 1–9 | `Mod+Shift+1` à `Mod+Shift+9` |
| Infos de l’instance | `Mod+Shift+L` |
| Rechercher dans l’historique de session | `Mod+F` |
| Résultat suivant / précédent (recherche focalisée) | `Enter` / `Shift+Enter` |
| Focaliser / Effacer la saisie | `Mod+P` / `Mod+K` |
| Ouvrir le sélecteur de modèle / d’agent | `Mod+Shift+M` / `Mod+Shift+A` |
| Sélectionner une variante de modèle | `Mod+Shift+T` |
| Déplacer les outils bloquants en arrière-plan (saisie) | `Mod+B` |
| Envoyer la saisie | `Enter` |
| Envoyer avec le comportement de suivi alternatif | `Alt+Enter` (Windows, Linux) ou `Mod+Shift+Enter` |
| Insérer une nouvelle ligne | `Shift+Enter` ou `Mod+Enter` |
| Prompt précédent / suivant (saisie) | `ArrowUp` / `ArrowDown` |
| Quitter la saisie / Quitter le mode shell | `Escape`, selon le contexte de saisie |
| Arrêter la session | Appuyer deux fois sur `Escape` ; le premier appui affiche une confirmation |
| Envoyer une question annexe (fenêtre `/btw`) | `Mod+Enter` |
| Enregistrer le fichier (éditeur de travail) | `Mod+S` |

Si l’envoi par Entrée est désactivé, **Envoyer la saisie** vaut par défaut `Mod+Enter` et **Insérer une nouvelle ligne** vaut `Enter` ou `Shift+Enter`. Un raccourci explicitement remplacé prime sur cette valeur. Utilisez le gestionnaire pour voir l’affectation effective. Session précédente/suivante parcourt la liste ; ce n’est pas l’historique **Retour**/**Avancer** de type navigateur de la barre latérale, qui n’a pas de raccourci.

## Touches natives et interception par la plateforme {#native-keys}

Les touches natives sont fixes et restent actives après modification ou désactivation de l’affectation correspondante du moteur de rendu. En particulier, **New Window** natif utilise `Mod+Shift+N`, valeur par défaut de Nouvelle session. Utilisez une commande Nouvelle session visible ou réaffectez l’action si le menu natif l’intercepte. De même, `Mod+W` natif peut fermer la fenêtre plutôt qu’un onglet de l’application.

| Action native | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | Commandes du menu View et zoom de la webview de la plateforme |
| Full Screen | `F11` sous Windows/Linux ; `Ctrl+Cmd+F` sous macOS | Accélérateur de menu `Ctrl+Cmd+F` sous macOS ; utiliser le menu sur les autres plateformes |
| Developer Tools | `Ctrl+Shift+I` sous Windows/Linux ; `Alt+Cmd+I` sous macOS | `Alt+Mod+I` |

Les fenêtres ordinaires de navigateur gardent aussi leurs raccourcis. Si une affectation n’atteint jamais CodeNomad, choisissez une autre combinaison plutôt que de désactiver la sécurité ou de changer les touches globales du système.

## Dispositions clavier et saisie de texte {#layouts-ime}

Les raccourcis de la rangée de chiffres et des crochets utilisent les positions physiques des touches pour la capture, l’exécution et les conflits, y compris sur AZERTY/QWERTZ. Les autres touches utilisent leurs valeurs logiques. Capturez sur le clavier prévu, puis vérifiez le résultat affiché.

Pendant la composition IME, la saisie de texte prime. L’historique des prompts et les actions Échap dépendent aussi du focus, de l’état du sélecteur/shell et de l’opération actuelle ; ne supposez pas qu’ArrowUp ou Échap soit toujours une action globale inconditionnelle. Les infobulles et le gestionnaire montrent les affectations actuelles sans ajouter une bande permanente d’aide clavier.
