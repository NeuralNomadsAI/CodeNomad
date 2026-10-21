# Historique, recherche et nettoyage

L’historique enregistré, ce que la transcription affiche actuellement et le contexte compacté du modèle sont distincts. Préférez la navigation ou le filtrage avant toute suppression.

## Rechercher dans tout l’historique {#full-history-search}

1. Ouvrez **Rechercher dans l'historique du chat** dans l’en-tête de conversation, ou utilisez son raccourci configuré (**Ctrl/Cmd+F** par défaut).
2. Sélectionnez **Session entière** ou **Workspace entier** et saisissez un terme.
3. Activez **Inclure les outils et réflexions** si vous avez besoin du contenu technique en plus du texte lisible.
4. Sélectionnez un extrait ou utilisez **Résultats suivants** pour dépasser la page actuelle.

La recherche est littérale et insensible à la casse, sur l’historique enregistré plutôt que les seules lignes de transcription montées. La portée de l’espace de travail suit l’arborescence autorisée et les worktrees du projet ouvert, pas tous les projets du service OpenCode ; ses résultats sont regroupés par conversation, chacune nommée par son titre et le worktree qui la contient actuellement. Les octets des pièces jointes fichier/image et l’état opaque du fournisseur ne sont pas du texte recherchable.

La ligne de progression **Cette page : … résultats · … messages parcourus** décrit cette page de résultats, pas les totaux de l’espace de travail. Les résultats arrivent par lots. Les messages trop volumineux ou non pris en charge ignorés sont signalés ; l’absence de résultat ne prouve pas qu’ils ne contiennent aucune correspondance. Les nouveaux messages arrivant pendant un parcours nécessitent une nouvelle recherche pour être inclus de façon cohérente.

Ouvrir une recherche vide ne parcourt pas l’historique. Changer la requête/la portée, fermer la fenêtre ou quitter la session annule le travail de recherche obsolète. Si une lecture échoue, utilisez **Réessayer** ; cela n’envoie pas de prompt et ne modifie pas l’historique.

## Ouvrir les résultats et utiliser la chronologie {#timeline-navigation}

1. Choisissez un résultat de la session actuelle pour atteindre le passage qui l’entoure.
2. Choisissez un résultat d’une autre session pour ouvrir un aperçu distinct de ce message ; utilisez **Ouvrir dans la session** pour aller à cette conversation, à l’emplacement du résultat.
3. Dans **Chronologie des messages**, survolez ou focalisez un marqueur pour un extrait, puis sélectionnez-le pour naviguer. Utilisez les commandes premier/dernier message pour revenir aux extrémités de l’historique enregistré.

La chronologie représente toute la structure de session même si la transcription ne contient qu’un passage borné. Les sauts chargent la destination sans récupérer tous les messages intermédiaires. Les aperçus de résultats d’autres sessions ne chargent pas leur transcription entière et ne les sélectionnent pas ; seul **Ouvrir dans la session** change de conversation.

Les marqueurs d’outils suivent **Contenu des messages** : un type d’outil masqué là n’a pas de marqueur (aucun avec **Rien**), sauf un outil en attente d’une autorisation. Une étape qui n’a exécuté que des outils n’affiche que ses marqueurs d’outils, sans marqueur d’agent vide.

Pendant un saut, l’ancien passage reste visible. Un saut plus récent ou une interaction manuelle avec la transcription remplace la navigation obsolète ; un saut échoué laisse le passage visible intact. Réessayez la destination plutôt que de recharger sans cesse tout le projet. La lecture historique ne modifie pas la sélection agent/modèle de la zone de saisie.

La chronologie est masquée si la conversation est trop étroite (moins de 420 pixels CSS) ; utilisez alors la recherche et les commandes de transcription. Sa préférence de visibilité enregistrée n’est pas effacée par cette adaptation.

## Choisir la bonne opération sur l’historique {#operation-reference}

| Opération | Où | Portée et conséquence |
| --- | --- | --- |
| Filtrage d’affichage | **Contenu des messages**, ou **Paramètres → Chat** | Préférences d’affichage de transcription partagées ; masque/replie le contenu sans le supprimer |
| Compactage | Palette **Compacter la session** | Résumé/compactage natif du contexte de la session sélectionnée, pas une suppression des sorties techniques |
| Nettoyage d’une réponse | Message **Plus d'actions → Supprimer les outils et raisonnements de cette réponse** | Retire définitivement les parties techniques terminées admissibles ; conserve le texte final |
| Nettoyage technique de session | Palette **Supprimer les outils et raisonnements de la session** | Planifie sur tout l’historique enregistré, y compris avant compactage ; conserve le texte final et les métadonnées de message/session |
| Supprimer une session | Ligne de session **Supprimer la session**, ou suppression des sessions sélectionnées | Supprime récursivement la conversation native, ses sous-sessions descendantes et leur historique après confirmation ; aucune annulation |
| Nettoyer les sessions | Palette de commandes | Suppression plus large de sessions, pas un réglage d’affichage ou de taille du contexte |

**Contenu des messages** s’applique à toutes les conversations. Choisissez un préréglage (**Rien**, **Minimal**, **Équilibré** ou **Tout**) en haut de cette fenêtre ou dans **Paramètres → Chat**, puis ajustez les lignes individuelles ; le menu de préréglage de **Contenu des messages** affiche alors **Personnalisé**. Masquer les outils ne désactive pas les outils, ne change pas les autorisations et ne retire pas les sorties enregistrées. Pour préserver la fluidité de l’affichage, les messages très volumineux affichent **Afficher … de plus** dans un intervalle omis, et les textes ou sorties d’outils très longs s’arrêtent à une ligne **… caractères de plus masqués** avec **Tout afficher**. Révéler l’un ou l’autre ne concerne que l’affichage et ne récupère pas du contenu supprimé.

## Compacter une session {#compact-session}

1. Sélectionnez la conversation voulue.
2. Exécutez **Compacter la session** depuis la palette de commandes.
3. Attendez le résultat du compactage natif ou consultez **Échec du compactage** avant de décider de réessayer.

Le compactage change le contexte utilisé par OpenCode pour poursuivre la session. Il ne promet pas d’effacer les anciens messages enregistrés : la recherche dans tout l’historique et le nettoyage technique peuvent encore atteindre le contenu antérieur. Ne compactez pas à la place de supprimer un historique sensible enregistré.

## Retirer les outils et raisonnements {#technical-cleanup}

1. Choisissez l’action d’une seule réponse, ou exécutez **Supprimer les outils et raisonnements de la session** pour la session sélectionnée.
2. Vérifiez les nombres d’outils/raisonnements prévus et les avertissements de contenu ignoré.
3. Confirmez **Supprimer**. Pour une session entière, suivez la progression au-dessus de la transcription et utilisez sa commande d’annulation au besoin.

Seuls les outils et raisonnements terminés admissibles sont retirés. Le contenu actif/incomplet n’est pas élagué ; un contenu modifié est refusé plutôt que d’élargir silencieusement votre confirmation. Le texte final et les métadonnées de message/session restent, mais les sorties techniques supprimées ne sont pas récupérables. Préservez ce dont vous avez besoin avant de confirmer.

Le nettoyage n’est pas atomique sur toute la session. Les suppressions antérieures réussies restent si un message ultérieur entre en conflit ou échoue. **L’annulation arrête les lots futurs ; elle n’annule pas un lot déjà envoyé**, qui peut encore être appliqué.

Pour une erreur de stockage occupé, attendez la fin de l’exécution/du travail de stockage actuel. Pour un message modifié, rechargez et sélectionnez à nouveau. Pour un plugin indisponible, reconnectez/rouvrez CodeNomad et inspectez l’erreur avant de réessayer. Après une réponse incertaine, actualisez et évaluez le contenu restant ; ne supposez ni que rien ne s’est passé ni que toute la session a été nettoyée.

## Supprimer et nettoyer les sessions {#delete-scrub}

Supprimer une session parente supprime aussi ses sous-sessions descendantes et leur historique. Inspectez la famille avant de confirmer. Le nettoyage des spécialistes d’une Mission est différent : il conserve les sessions qui ont des enfants.

1. Préférez **Supprimer la session** sur une ligne précise lorsque vous savez exactement quelle conversation doit disparaître.
2. Pour une maintenance plus large, exécutez **Nettoyer les sessions** et lisez la confirmation **Nettoyage approfondi des sessions**.
3. Confirmez uniquement si les sessions vides, les sessions de sous-agents terminées et les bifurcations inutilisées peuvent être supprimées.

Le nettoyage agit sur les sessions candidates connues du projet actuel et peut retirer davantage que les seules sessions principales vides. Ce n’est pas un archivage et il n’y a pas d’annulation. Ne l’utilisez pas simplement pour masquer une barre latérale chargée. La préférence indépendante **Nettoyage auto des sessions vides** est plus restreinte : elle vérifie qu’une session est réellement vide au lieu de considérer une transcription non chargée comme vide.

La suppression retire des conversations, pas des commits Git, et n’annule pas les effets sur le système de fichiers ou les services externes. Si le nettoyage ne réussit qu’en partie, les sessions déjà supprimées le restent. Vérifiez la liste restante et les erreurs avant de réessayer. Voir [Conversations](conversations.md) pour les bifurcations/annulations et [Projets](projects.md) pour supprimer des dossiers temporaires ou worktrees.
