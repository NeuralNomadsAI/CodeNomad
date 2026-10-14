# Paramètres et disposition

## Ouvrir les paramètres et identifier leur portée {#open-settings}

1. Ouvrez **Paramètres** depuis l’accueil ou la palette de commandes.
2. Sélectionnez une section. Les fenêtres locales Electron et Tauri ouvrent ou focalisent une unique fenêtre native Preferences ; les vues navigateur et distantes utilisent l’écran de paramètres intégré.
3. Vérifiez la portée du réglage et toute action **Enregistrer** avant de quitter.

La plupart des commutateurs s’appliquent immédiatement. Les éditeurs comme la voix, les palettes et les préférences de Missions ont des commandes d’enregistrement explicites. Un échec d’enregistrement ne confirme pas que le changement a pris effet ; rouvrez ou actualisez la section concernée avant de réessayer.

| État | Ce qu’il contrôle |
| --- | --- |
| Configuration CodeNomad | Préférences d’interface, voix, SideCars et paramètres serveur pour les clients de cette configuration. Un badge « Appareil » ne promet pas une isolation d’un autre client partageant la configuration. |
| Disposition de fenêtre/d’onglet de projet | Panneaux ouverts, onglets sélectionnés, état du lecteur et brouillons/disposition restaurables. Ce n’est pas de la configuration OpenCode. |
| Paramètres OpenCode Global/Projet | Changements de plugins/configuration natifs à la portée affichée. Les commandes Projet nécessitent un projet/une Location actif. |
| Profil de données de bureau | Fenêtres natives, état de restauration et stockage navigateur, indépendamment du fichier de configuration et du service OpenCode partagé. Voir [Fenêtres de bureau et données](desktop.md). |

Changer les préférences d’affichage ne redémarre pas OpenCode et ne rejoue pas de prompt. Configuration native, maintenance du service et identifiants ont des effets distincts : voir [Configuration d’OpenCode](opencode.md), [Fournisseurs](providers.md) et [Intégrations](integrations.md).

## Langue et apparence {#language-appearance}

1. Dans **Général**, sélectionnez **Langue** : anglais, espagnol, français, russe, japonais, chinois simplifié, hébreu, allemand, népalais ou turc.
2. Choisissez **Mode d’apparence** : **Auto**, **Clair** ou **Sombre**. Auto suit le système d’exploitation.
3. Choisissez une palette pour l’apparence affichée. Les sélections claire et sombre sont enregistrées indépendamment ; Auto utilise celle qui correspond.
4. Pour des couleurs personnalisées, utilisez les échantillons et **Enregistrer** ; **Réinitialiser** restaure les couleurs de cette palette. Utilisez **Nouveau** pour nommer une palette distincte.

L’interface se met à jour sans redémarrer de conversation. L’hébreu utilise une disposition de droite à gauche ; code et valeurs techniques restent lisibles dans leur propre sens. La sélection de langue change les textes d’interface, pas la langue des messages existants ou instructions d’agent. Les menus natifs du système peuvent rester en anglais.

Si les couleurs deviennent difficiles à lire, sélectionnez une palette intégrée ou réinitialisez celle modifiée. Changer de palette peut demander d’abandonner les modifications de couleur non enregistrées ; cela n’abandonne pas un brouillon de conversation.

## Panneaux et sections Statut {#panels-status}

1. Utilisez **Volet gauche** et **Volet droit** aux coins extérieurs de l’en-tête, ou leurs entrées du menu **View**, pour afficher ou masquer chaque panneau.
2. Ouvrez **Personnaliser le panneau droit** dans le panneau droit. Utilisez les cases pour choisir les onglets intégrés et sections Statut ; au moins une section Statut reste visible.
3. Faites glisser les onglets du panneau droit pour les réordonner. Utilisez **Réinitialiser** pour restaurer les choix de disposition intégrée.

Statut inclut les informations de tokens, le mode Yolo, l’utilisation fournisseur, les processus en arrière-plan, MCP et Plugins. Masquer une section ne désactive pas son service et ne révoque pas de permissions. Les dispositions étroites font flotter les panneaux sur la conversation au lieu de la comprimer ; ouvrir un panneau flottant ferme l’autre.

La disposition intégrée est propre à la fenêtre, pas une modification du projet. Les cases d’extension sont différentes : elles activent du code dans tous les projets utilisant la configuration. **Réinitialiser** ne change pas le consentement aux extensions. Voir [Extensions de panneau](extensions.md).

## Détail de transcription et taille de saisie {#transcript-composer}

1. Ouvrez **Chat** pour choisir les niveaux de détail par défaut. Les préréglages sont **Minimal**, **Balanced**, **Detailed** et **Everything** ; les changements individuels produisent **Custom**.
2. Ajustez réflexion, entrées/sorties d’outils, diagnostics et détails des tokens, ou utilisez le menu **Contenu des messages** de la conversation pour les commandes de visibilité partagées.
3. Dans **Général**, ajustez **Chronologie des messages**, **Appels d'outils dans la chronologie**, **Vue du diff** et **Comportement des messages de suivi** au besoin.
4. Redimensionnez la zone de saisie avec sa commande ; les longs brouillons défilent dans le champ.

Les réglages de visibilité et de développement changent seulement la présentation. Ils ne retirent pas les outils/raisonnements enregistrés et ne compactent pas le contexte du modèle. Voir [Historique et nettoyage](history.md) pour les opérations destructrices.

La hauteur de saisie suit la conversation visible, y compris le clavier logiciel : minimum 8 % avec un plancher de 44 px, maximum 60 %. La hauteur manuelle est mémorisée proportionnellement ; une largeur étroite et un long texte n’augmentent pas ces limites. Une autorisation/question développée réduit temporairement la saisie sans changer sa hauteur enregistrée ni son brouillon. Repliez ou réglez la demande pour reprendre le redimensionnement.

## Notifications et badges {#notifications}

1. Ouvrez **Notifications** et choisissez **Demander** si la permission n’a pas été accordée.
2. Activez **Activer les notifications**.
3. Choisissez **Une session nécessite une saisie**, **Une session devient inactive**, et si vous souhaitez **Notifier lorsque l'application est au premier plan**.

La permission navigateur/système appartient à l’appareil et à l’origine applicative ; une préférence enregistrée ne peut pas contourner un refus. Si elle est bloquée, activez les notifications dans les paramètres du navigateur ou du système, puis revenez ici. Les environnements non pris en charge gardent la commande désactivée.

Le nombre de non-lus de la cloche/de l’historique pilote le point de favicon et le badge de l’application native. Les badges natifs agrègent les fenêtres principales actives ; ils ne comptent pas les sessions en cours et ne prouvent pas qu’une notification système a été livrée. Cette fonctionnalité ne fournit pas de badges de lanceur PWA.

## Options avancées {#advanced}

1. Ouvrez **Avancé**.
2. Changez seulement le comportement nécessaire ; les commutateurs enregistrent via les préférences CodeNomad. Modifiez séparément **Variables d'environnement** pour changer l’environnement d’exécution des sessions.
3. Vérifiez la vue résultante ou l’envoi suivant plutôt que de redémarrer spéculativement le service partagé.

| Option | Effet et précaution |
| --- | --- |
| Nettoyage auto des sessions vides | Nettoie les sessions vides à la création de nouvelles ; laissez désactivé pour les conserver. |
| Conserver les marqueurs d’inactivité des sous-agents | Conserve les marqueurs d’inactivité non vus jusqu’à consultation plutôt que de les masquer après cinq secondes. |
| Focaliser la fenêtre existante au second lancement | Bureau natif seulement ; change le comportement de fenêtre au second lancement, pas la création d’onglets. |
| Solde de crédits du fournisseur | Affiche les soldes complémentaires dans Utilisation ; n’achète pas de crédits et ne change pas de compte. |
| Masquer les changements d’espaces | Omet les fichiers non indexés ne différant que par espaces/fins de ligne de Changements et ses actions groupées ; les fichiers indexés restent visibles. Voir [Fichiers](files.md). |
| Retenir les longues réponses de l’assistant | Arrête le suivi automatique lorsqu’une réponse en cours dépasse la zone visible. |
| Variables d’environnement | Appliquées côté serveur avant chaque prompt ou commande de session ; les lectures ne mettent pas à jour une exécution déjà active. Voir [Configuration d’OpenCode](opencode.md). |

Pour configurer le clavier, voir [Raccourcis clavier](shortcuts.md) ; pour les commandes vocales, voir [Saisie et lecture vocales](voice.md). La restauration au démarrage et la suppression de profils de bureau enregistrés sont décrites dans [Fenêtres de bureau et données](desktop.md).
