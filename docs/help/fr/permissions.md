# Questions et autorisations

Les questions, Forms et demandes d’autorisation natives se traitent dans le dock d’interruption juste au-dessus de la zone de saisie, pas dans les cartes d’outils en attente de la transcription.

## Trouver la demande et vérifier sa source {#request-dock}

1. Sélectionnez une conversation avec **Entrée requise** / **Autorisation requise**, ou cliquez sur le badge de demande du projet pour ouvrir le dock sur place.
2. Lisez le type de demande, le titre de conversation et la provenance avant de développer ou de répondre.
3. Si plusieurs demandes attendent, utilisez **Demande précédente** / **Demande suivante**. Utilisez **Voir la conversation** seulement pour naviguer vers sa source.

| Provenance | Sens et comportement |
| --- | --- |
| Conversation ouverte | Sa demande peut se développer normalement |
| Sous-agent, avec parent **Depuis …** | Un descendant récursif de la conversation ouverte relève du contexte local ; la provenance du parent reste visible |
| Autre conversation | Commence par un aperçu compact ; développez explicitement pour répondre sans quitter la conversation actuelle |
| Demande de projet / de service | Un Form peut ne pas avoir de conversation propriétaire ; aucun lien de conversation inventé n’est affiché |

**Replier les demandes** masque le corps ; cela ne refuse, n’annule et ne répond à rien. Un éditeur développé réduit temporairement la zone de saisie à sa hauteur minimale sans changer sa taille enregistrée ni son brouillon. Son contenu défile indépendamment des actions de réponse fixes.

## Répondre aux questions et Forms {#answer-questions-forms}

1. Développez la demande voulue et remplissez ses champs ou sélectionnez les choix proposés.
2. Lorsqu’un champ de choix autorise les réponses personnalisées, un champ de texte supplémentaire s’affiche : saisissez-y votre propre réponse à la place d’un choix proposé (ou ajoutez des valeurs personnalisées pour un champ à choix multiples). Répondez à chaque question obligatoire.
3. Choisissez **Envoyer** ; n’utilisez **Annuler** pour une question ou un Form que si vous souhaitez cette annulation native.

Les réponses partielles et brouillons de refus survivent aux actualisations de file et à la navigation entre conversations dans le client actif. Ce ne sont ni une décision soumise ni une garantie de récupération après effacement des données du client.

Certains Forms proposent **Ouvrir le formulaire externe** pour un parcours navigateur. Suivez les instructions puis revenez à son statut, sans considérer une page ouverte comme une réponse réussie. Les Forms arbitraires de fournisseur/d’authentification ne sont pas nécessairement des éléments de conversation.

Les outils de question natifs terminés montrent dans l’historique la question, la réponse sélectionnée, les descriptions d’options et le texte personnalisé exact. **Autres choix** garde les autres choix accessibles. Ces résultats terminés sont distincts du dock actif.

## Autoriser ou refuser une permission {#permission-decisions}

1. Lisez l’opération, les ressources et l’éventuel **Diff demandé**. Vérifiez quelle conversation recevra la décision.
2. Saisissez éventuellement un commentaire expliquant un refus ou une solution plus sûre.
3. Choisissez **Autoriser une fois**, **Toujours autoriser** ou **Refuser**.

| Choix | Effet natif | Limite de sécurité |
| --- | --- | --- |
| Autoriser une fois | Approuve cette demande d’autorisation | Pas une approbation globale d’opérations futures sans rapport |
| Toujours autoriser | Envoie le choix natif d’approbation persistante des demandes correspondantes dans le contexte de session applicable | Pas un commutateur de confiance pour tout CodeNomad ou tout le système ; vérifiez la ressource/le motif autorisé |
| Refuser | Rejette la demande, avec commentaire facultatif | N’annule pas le travail effectué avant cette demande |

L’approbation peut déclencher immédiatement l’exécution d’un outil. Ce n’est pas une simulation. Les limites de diff/lecture et les contrôles d’identité de source peuvent empêcher une approbation si le contenu demandé ne peut pas être validé ; actualisez et examinez la demande réelle plutôt que d’approuver par supposition une autre opération.

Si un autre client règle une demande, elle peut disparaître ici. Un délai dépassé ou une réponse échouée ne prouve pas si le service natif a accepté la décision : laissez la réconciliation des demandes actualiser le dock avant de faire un autre choix délibéré.

## Lire les reçus d’autorisation {#permission-receipts}

1. Cherchez **Décisions d’autorisation** à côté du contenu de transcription associé, même si les cartes d’outils natives sont masquées.
2. Pour les décisions sans message source, ouvrez **Décisions d’autorisation de la session**.
3. Utilisez **Charger d’autres décisions** pour continuer, ou **Réessayer** après un échec de lecture.

Les reçus enregistrent les demandes/ressources connues, la décision confirmée et le motif/la provenance disponible. **Décision dans CodeNomad**, **Décision automatique** et **Décision native** distinguent les origines observées ; un règlement natif ne prouve pas un clic utilisateur dans cette fenêtre.

Les reçus sont des annotations CodeNomad en lecture seule, pas des messages natifs ou des éditeurs de règles d’autorisation. Ils sont exclus de la recherche native dans tout l’historique, de la copie des messages et de l’export. Ils ne peuvent pas reconstruire les décisions manquées quand CodeNomad était hors ligne, et un résultat d’outil réussi ne remplace pas un reçu manquant. Supprimer une session retire ses reçus.

## Mode de permissions par conversation {#conversation-mode}

Sélectionnez une conversation, ouvrez **Statut → Permissions** et cliquez sur un mode. Quand la section est repliée, un éclair (Autonome) ou un bouclier (Supervisé) indique le dernier mode connu.

- **Autonome** — Applique les règles de permissions d’OpenCode.
- **Supervisé** — Demande confirmation avant que l’agent modifie des fichiers ou exécute des commandes shell. Pour ces actions, les interdictions globales, du projet et de la conversation restent en vigueur, et les règles d’autorisation deviennent des demandes. Les accords **Toujours autoriser** enregistrés par OpenCode restent valables pour les demandes correspondantes.

Les deux modes utilisent les règles de session d’OpenCode, y compris dans son interface terminal lorsqu’elle est connectée au même service et ouverte sur la même conversation. Revenir à **Autonome** retire seulement les règles ajoutées pour la supervision. Les fichiers de configuration d’OpenCode restent inchangés. CodeNomad n’approuve pas automatiquement les demandes, quel que soit le mode.

Le mode Supervisé n’est pas un bac à sable. Les lectures, les accès hors projet et les outils MCP gardent leurs propres règles. Les demandes ouvertes gardent leurs règles initiales.

Dans un sous-agent, **Permissions** affiche et modifie le mode de la conversation racine. Les sous-agents existants gardent leurs règles quand le mode change ; lorsqu’un sous-agent en lance un autre, le nouveau copie les règles de son parent direct.

Une conversation bifurquée copie les règles de sa source et a son propre mode. Si CodeNomad ne peut pas vérifier quelles règles retirer, la conversation bifurquée les conserve et vous pouvez toujours envoyer des messages.

Si le mode n’est pas confirmé, choisissez **Recharger les permissions**. Pour régler le mode initial, voir [Permissions des nouvelles conversations](settings.md#new-conversation-permissions).

## Récupérer les demandes manquantes ou périmées {#request-recovery}

1. Vérifiez l’indicateur de connexion et reconnectez-vous au même backend/projet.
2. Laissez la récupération réconcilier les demandes natives en attente ; les demandes connues et brouillons restent conservés si la couverture est incomplète.

Les échecs temporaires de récupération sont réessayés en arrière-plan sans créer de notification. Si le plugin OpenCode intégré ne peut pas lister les demandes en attente, un seul avis par backend s’affiche dans l’onglet du navigateur jusqu’à ce que la récupération réussisse.

Une réponse incomplète n’est pas une file vide faisant autorité, et un avis de plugin indisponible n’autorise pas à répéter un prompt, une réponse ou une approbation. Recharger la configuration peut annuler des Forms/autorisations natifs ; ne l’utilisez pas comme bouton d’actualisation habituel des demandes. Voir [Dépannage](troubleshooting.md) et [Configuration d’OpenCode](opencode.md).
