# Paramètres et disposition

## Ouvrir les paramètres et identifier leur portée {#open-settings}

1. Ouvrez **Paramètres** avec l’engrenage **Ouvrir les paramètres** de la barre d’onglets (de la barre de titre dans l’application de bureau macOS) ou de l’accueil. Des raccourcis comme **Gérer les fournisseurs** dans le sélecteur de modèle, l’engrenage du panneau Missions ou l’engrenage **Paramètres** de l’historique des notifications ouvrent directement la section correspondante.
2. Sélectionnez une section. Les fenêtres locales Electron et Tauri ouvrent ou focalisent une unique fenêtre native Preferences ; les vues navigateur et distantes utilisent l’écran de paramètres intégré.
3. Vérifiez la portée du réglage et toute action **Enregistrer** avant de quitter.

La plupart des choix s’appliquent immédiatement, y compris les préférences de Missions, qui enregistrent chaque changement au fur et à mesure. La voix, les couleurs de palette personnalisées et les fichiers de configuration gardent un **Enregistrer** explicite. Un échec d’enregistrement ne confirme pas que le changement a pris effet ; rouvrez ou actualisez la section concernée avant de réessayer. Les explications se trouvent derrière le **i** à côté du titre d’un réglage : survolez-le ou focalisez-le, ou touchez-le sur un écran tactile.

| État | Ce qu’il contrôle |
| --- | --- |
| Configuration CodeNomad | Préférences d’interface, voix, SideCars et paramètres serveur pour les clients de cette configuration. Les préférences sans badge ne sont pas non plus enregistrées par appareil ; **Paramètre serveur** signale une configuration côté serveur comme la voix, les SideCars, le Contrôle à distance et les variables d’environnement. |
| Disposition de fenêtre/d’onglet de projet | Panneaux ouverts, onglets sélectionnés, état du lecteur et brouillons/disposition restaurables. Ce n’est pas de la configuration OpenCode. |
| Paramètres OpenCode Global/Projet | Changements de plugins/configuration natifs à la portée affichée. Les commandes Projet nécessitent un projet/une Location actif. |
| Profil de données de bureau | Fenêtres natives, état de restauration et stockage navigateur, indépendamment du fichier de configuration et du service OpenCode partagé. Voir [Fenêtres de bureau et données](desktop.md). |

**Stats** couvre tout le service OpenCode connecté (tous les projets, clones indépendants et sous-sessions), pas seulement le dossier ouvert, sur les 7, 30, 90 ou 365 derniers jours. Il nécessite un projet ouvert et affiche les tokens et coûts enregistrés par OpenCode, pas les factures des fournisseurs ni les allocations d’abonnement ; les derniers totaux enregistrés peuvent s’afficher pendant l’actualisation. Les quotas de forfait relèvent de la section Statut **Utilisation**.

Changer les préférences d’affichage ne redémarre pas OpenCode et ne rejoue pas de prompt. Configuration native, maintenance du service et identifiants ont des effets distincts : voir [Configuration d’OpenCode](opencode.md), [Fournisseurs](providers.md) et [Intégrations](integrations.md).

## Langue et apparence {#language-appearance}

1. Dans **Général**, sélectionnez **Langue** : anglais, espagnol, français, russe, japonais, chinois simplifié, hébreu, allemand, népalais ou turc.
2. Dans **Palette de couleurs**, choisissez **Mode** : **Auto**, **Sombre** ou **Clair**. Auto suit le système d’exploitation.
3. Choisissez une palette pour l’apparence affichée. Les sélections claire et sombre sont enregistrées indépendamment ; Auto utilise celle qui correspond.
4. Pour des couleurs personnalisées, utilisez les échantillons et **Enregistrer** ; **Réinitialiser** restaure les couleurs d’une palette intégrée. Utilisez **Nouveau** pour nommer une palette distincte et **Supprimer** pour retirer une palette que vous avez créée.

L’interface se met à jour sans redémarrer de conversation. L’hébreu utilise une disposition de droite à gauche ; code et valeurs techniques restent lisibles dans leur propre sens. La sélection de langue change les textes d’interface, pas la langue des messages existants ou instructions d’agent. Les menus natifs du bureau passent à la langue de l’interface dès qu’une fenêtre CodeNomad est chargée.

Si les couleurs deviennent difficiles à lire, sélectionnez une palette intégrée ou réinitialisez celle modifiée. Changer de palette peut demander d’abandonner les modifications de couleur non enregistrées ; cela n’abandonne pas un brouillon de conversation.

## Panneaux et sections Statut {#panels-status}

1. Utilisez **Volet gauche** et **Volet droit** aux coins extérieurs de l’en-tête, ou leurs entrées du menu **Affichage**, pour afficher ou masquer chaque panneau.
2. Ouvrez **Personnaliser le panneau droit** dans le panneau droit. Utilisez les cases pour choisir les onglets intégrés et sections Statut ; au moins une section Statut reste visible.
3. Faites glisser les onglets du panneau droit pour les réordonner. Utilisez **Réinitialiser** pour restaurer les choix de disposition intégrée.

Statut inclut les informations de tokens, le mode Yolo, l’utilisation fournisseur, les shells en arrière-plan, MCP et Plugins. Masquer une section ne désactive pas son service et ne révoque pas de permissions. Les dispositions étroites font flotter les panneaux sur la conversation au lieu de la comprimer ; ouvrir un panneau flottant ferme l’autre.

La disposition intégrée est propre à la fenêtre, pas une modification du projet. Les cases d’extension sont différentes : elles activent du code dans tous les projets utilisant la configuration. **Réinitialiser** ne change pas le consentement aux extensions. Voir [Extensions de panneau](extensions.md).

## Détail de transcription et taille de saisie {#transcript-composer}

1. Ouvrez **Chat** pour choisir les niveaux de détail par défaut. Les préréglages sont **Rien**, **Minimal**, **Équilibré** et **Tout** ; les changements individuels produisent **Personnalisé**.
2. Réglez l’**État par défaut** de chaque ligne (**Masqué**, **Réduit** ou **Développé**) pour la réflexion, les diagnostics, les entrées d’outils, les tokens, les messages système et chaque type d’outil, ou utilisez le menu **Contenu des messages** de la conversation, qui partage ces choix.
3. Dans **Général**, cochez au besoin **Afficher la chronologie des messages**, **Scinder les diffs des appels d’outils** et **Mettre les prompts envoyés en file d’attente** (mettre en file les prompts envoyés pendant qu’une session travaille au lieu de l’orienter).
4. Redimensionnez la zone de saisie avec sa commande ; les longs brouillons défilent dans le champ.

La chronologie a un marqueur pour chaque réponse, réflexion, outil, compactage et contexte système affiché dans la conversation, dans le même ordre. Ses marqueurs suivent **Contenu des messages** : masquer à cet endroit un type d’outil, la réflexion ou les messages système masque aussi leurs marqueurs, sauf celui d’un outil avec une autorisation en attente, et **Rien** masque tous les marqueurs d’outils. Les réglages de visibilité et de développement changent seulement la présentation. Ils ne retirent pas les outils/raisonnements enregistrés et ne compactent pas le contexte du modèle. Voir [Historique et nettoyage](history.md) pour les opérations destructrices.

La hauteur de saisie suit la conversation visible, y compris le clavier logiciel : minimum 8 % avec un plancher de 44 px, maximum 60 %. La hauteur manuelle est mémorisée proportionnellement ; une largeur étroite et un long texte n’augmentent pas ces limites. Une autorisation/question développée réduit temporairement la saisie sans changer sa hauteur enregistrée ni son brouillon. Repliez ou réglez la demande pour reprendre le redimensionnement.

## Notifications et badges {#notifications}

1. Ouvrez **Notifications**. Pour chaque type de notification, cochez où elle apparaît : **À l'écran** (une bulle temporaire), **Historique** (conservée dans l’historique des notifications de la cloche de la barre d’onglets, ou de la barre de titre dans l’application de bureau macOS) et **Système** (une notification du système d’exploitation).
2. Cocher une case **Système** demande l’autorisation si nécessaire. Sous **Notifications système**, **Demander** relance la demande tant que l’autorisation manque.
3. Activez **Notifier lorsque l'application est au premier plan** pour garder les notifications système pendant que cette fenêtre est au premier plan. Sinon, elles s’affichent dès qu’elle ne l’est pas, même si elle reste ouverte à l’écran.

Par défaut, **Une session attend votre réponse** et **Une session est terminée** vont uniquement vers Système, afin que les états passagers des sessions ne s’accumulent pas dans l’Historique ; elles concernent les sessions principales, pas les sous-agents, et une session que vous arrêtez vous-même n’est pas annoncée. Les erreurs apparaissent toujours à l’écran et dans l’Historique, quoi qu’indique le tableau, et les courts messages de progression restent uniquement à l’écran.

La permission navigateur/système appartient à l’appareil et à l’origine applicative ; une préférence enregistrée ne peut pas contourner un refus. Si elle est bloquée, activez les notifications dans les paramètres du navigateur ou du système, puis revenez ici. Les environnements non pris en charge gardent la colonne Système désactivée.

Le nombre de non-lus de la cloche/de l’historique, qui ne compte que les notifications dirigées vers l’Historique, pilote le point de favicon et le badge de l’application native. Les badges natifs agrègent les fenêtres principales actives ; ils ne comptent pas les sessions en cours et ne prouvent pas qu’une notification système a été livrée. Cette fonctionnalité ne fournit pas de badges de lanceur PWA.

## Options avancées {#advanced}

1. Ouvrez **Avancé**.
2. Cochez ou décochez seulement les options nécessaires ; chaque changement est enregistré via les préférences CodeNomad. Pour changer l’environnement d’exécution des sessions, dépliez le groupe replié **Variables d'environnement** à la fin.
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
