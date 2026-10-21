# Fournisseurs et comptes

L’authentification des fournisseurs appartient au service OpenCode connecté, pas à l’appareil du navigateur ni à un projet CodeNomad. Les préférences d’affichage des modèles, les quotas d’abonnement et les choix de recherche web ont des portées différentes.

## Connecter un fournisseur de modèles ou de recherche {#connect}

1. Ouvrez un espace de travail, puis **Paramètres → Fournisseurs**. **Modèles** est déplié au départ ; dépliez **Recherche web** pour les fournisseurs de recherche.
2. Dans ce groupe, choisissez **Sélectionner un fournisseur**, puis **Connecter**.
3. Pour un fournisseur de modèles, effectuez la **Méthode d'authentification** native proposée : clé API, OAuth ou commande. Pour OAuth, utilisez **Ouvrir la page d'autorisation** et ne soumettez un code d’autorisation que si demandé. Les fournisseurs de recherche se connectent avec une clé API.
4. Vérifiez la ligne du fournisseur configuré après la fin. **Modèles** relit l’état après les connexions, les changements de compte et les reconnexions ; **Recherche web** dispose aussi d’**Actualiser**.

Les intégrations de recherche seules apparaissent sous **Recherche web**, pas **Modèles**. Enregistrer l’authentification ne choisit pas un modèle et ne change pas le fournisseur de recherche par défaut. Le serveur OpenCode actif enregistre les clés API et identifiants OAuth. Le navigateur reçoit des métadonnées de connexion, pas les secrets enregistrés. Une connexion issue de variables d’environnement est en lecture seule ici : modifiez son environnement propriétaire au lieu de tenter de la déconnecter ici.

Si la fenêtre d’autorisation est bloquée, utilisez **Ouvrir la page d'autorisation**, **Ouvrir dans cet onglet** ou **Copier le lien** dans le parcours. Ne publiez pas le lien ou code d’autorisation dans les diagnostics.

## Sélectionner et gérer les comptes {#accounts}

1. Dans la ligne du fournisseur, utilisez **Compte actif** pour sélectionner un identifiant enregistré.
2. Utilisez **Ajouter un compte** pour authentifier une autre connexion.
3. Pour gérer un autre compte enregistré, sélectionnez-le d’abord, puis utilisez **Renommer le compte** ou **Supprimer le compte**. Le renommage utilise **Nom du compte** et **Enregistrer** ; **Supprimer le compte** agit immédiatement, sans confirmation.

La sélection, le renommage et la suppression affectent cette intégration dans tout le service OpenCode, y compris d’autres projets et clients. Retirer un identifiant peut les priver d’authentification ; cela ne supprime pas l’historique et ne révoque pas le compte distant du fournisseur. Les connexions d’environnement ne peuvent pas être sélectionnées comme identifiants enregistrés modifiables ni retirées ici. Si une opération échoue, CodeNomad relit les comptes : vérifiez de nouveau **Compte actif** avant d’agir.

### Limites de la sélection automatique {#automatic-selection}

Avec plusieurs identifiants enregistrés sur une intégration prise en charge, **Sélection automatique du compte** active volontairement la sélection par quota avant l’admission du prochain prompt/de la prochaine commande personnalisée via CodeNomad. Ce réglage est propre à chaque intégration dans la configuration CodeNomad ; la sélection de compte résultante s’applique à tout le service.

| Intégration admissible | Type de compte admissible |
| --- | --- |
| OpenAI / Codex | Comptes d’abonnement Codex OAuth par navigateur/appareil, pas les clés OpenAI à l’usage ni la méthode de connexion ChatGPT dont OpenAI ne fournit pas l’utilisation. |
| OpenCode Go | Clé Go, ou connexion/clé OpenCode Console utilisée pour le **fournisseur Go uniquement**, pas les crédits Zen à l’usage. |
| Anthropic | Connexion OAuth Claude Pro/Max d’OpenCode, **pas** la connexion Claude Code. |
| GitHub Copilot | OAuth avec quota de requêtes premium lisible ; les identifiants de points d’accès d’entreprise ne sont pas des candidats lisibles. |
| Offres de codage | À clé : `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Seul un compte courant au quota saturé déclenche un changement ; une alternative disposant de plus de quota ne suffit pas. Les lectures examinent les identifiants enregistrés explicites sans activer les candidats ni échanger de jetons de rafraîchissement. Codex, Copilot et les offres de codage exigent un candidat manifestement disponible. Go, Console et Claude peuvent utiliser un candidat au quota inconnu sauf si un échec natif récent de quota le marque comme épuisé. Le point d’accès d’utilisation d’OpenCode Go et l’utilisation OAuth Console restent non vérifiés en amont ; la disponibilité n’est donc pas garantie.

Ce n’est **pas un basculement en cours de requête**. Cela ne réessaie pas les requêtes échouées et ne rejoue ni prompts, ni commandes, ni modifications. Cela ne fait pas tourner les connexions d’environnement, fournisseurs arbitraires, soldes à l’usage ou connexions Claude Code externes. Les changements manuels de compte sont respectés pendant la préparation ; aucun verrou interclients n’existe. En cas d’erreur de quota/authentification, vérifiez **Compte actif**, actualisez Utilisation et reconnectez-vous via le propriétaire de l’identifiant au besoin avant d’envoyer à nouveau délibérément.

## Visibilité des modèles, favoris et Réflexion {#models}

1. Choisissez **Gérer les modèles** à côté d’un fournisseur de modèles.
2. Recherchez par nom/ID et changez la visibilité ; **Tout afficher** et **Tout masquer** affectent sa liste de sélection.
3. Dans le sélecteur **Modèle** d’une conversation, utilisez **Ajouter aux favoris** ou **Retirer des favoris** ; **Afficher tous les modèles** quitte le filtrage limité aux favoris.
4. Utilisez **Réflexion** dans la zone de saisie pour les variantes exposées par le modèle sélectionné.

La visibilité et les favoris organisent les sélecteurs de CodeNomad ; ils ne désinstallent pas les modèles, ne retirent pas les identifiants et n’empêchent pas les autres clients OpenCode de les utiliser. Masquer un modèle ne déconnecte pas un compte. Réflexion sélectionne une variante pour les envois suivants, pas la visibilité du raisonnement déjà présent. Restaurez les modèles masqués avec **Gérer les modèles → Tout afficher**.

## Utilisation, comptes de tokens et connexions expirées {#usage}

Utilisez **Utilisation** dans le panneau droit pour les fenêtres de quota du fournisseur de la conversation active, leurs réinitialisations et les soldes pris en charge. Ces lectures diffèrent des **Tokens** par message et des estimations de coût : un quota d’abonnement n’est pas une facture calculée sur la transcription visible. Une lecture manquante, périmée ou inconnue n’est ni une utilisation nulle ni une preuve de capacité restante. **Solde de crédits du fournisseur** dans **Paramètres → Avancé** contrôle l’affichage complémentaire du solde.

OpenAI ne fournit pas l’utilisation pour l’une des méthodes de connexion ChatGPT : Utilisation l’indique au lieu d’afficher les fenêtres de quota. Le chat fonctionne toujours, et reconnecter la même connexion ne rétablit pas la lecture.

L’utilisation suit l’identifiant natif sélectionné. Claude via `anthropic`/`claude` utilise l’OAuth Anthropic d’OpenCode. Le fournisseur `claude-code` utilise la connexion Claude Code sur l’hôte du démon, y compris sa distribution WSL : `CLAUDE_CODE_OAUTH_TOKEN`, puis la connexion enregistrée, avec `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` ou `~/.claude` déterminant le stockage fichier ; macOS local peut utiliser le Trousseau. CodeNomad ne remplace pas une connexion Claude par l’autre.

Pour une connexion fournisseur expirée, actualisez/reconnectez-vous via son propriétaire — OpenCode, Claude Code ou Codex CLI — puis actualisez CodeNomad. CodeNomad n’échange pas de jetons de rafraîchissement externes. L’expiration de connexion au serveur CodeNomad est distincte : reconnectez-vous à CodeNomad sans supposer qu’une requête fournisseur échouée sera renvoyée. Voir [Dépannage](troubleshooting.md).

### Variables d’environnement d’utilisation facultatives {#usage-environment}

Définissez-les dans l’environnement du **processus backend CodeNomad** avant son lancement. Ce sont des identifiants pour les lecteurs d’utilisation, pas des paramètres navigateur ou commandes de sélection de modèle. Modifier l’éditeur de session **Variables d'environnement** ne met pas à jour le `process.env` d’un backend actif pour ces lecteurs. Redémarrez le backend dans l’environnement voulu pour les changer ; ne redémarrez pas le service OpenCode partagé uniquement pour une variable de lecture d’utilisation.

| Intégration d’utilisation | Variable d’environnement |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, avec repli sur `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| Utilisation complémentaire OpenCode Go | `OPENCODE_GO_WORKSPACE_ID` et `OPENCODE_GO_AUTH_COOKIE` ensemble |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — clé de plateforme, distincte de la clé d’inférence |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | Repli `COMMAND_CODE_API_KEY` si aucun identifiant natif n’est disponible |

Gardez les jetons/cookies hors de l’historique shell, des captures et des rapports. Les lecteurs facultatifs dépendent des API fournisseurs et de la validité des identifiants ; configurer une variable ne garantit pas des données de quota utilisables.

## Recherche web par défaut et remplacement Projet {#web-search}

1. Dans **Paramètres → Fournisseurs**, dépliez **Recherche web** et connectez l’intégration de recherche avec sa clé API si elle en nécessite une.
2. Choisissez **Recherche par défaut** pour la configuration Global.
3. Utilisez **Pour le projet courant** pour la remplacer dans la Location active. Survolez ou focalisez ce sélecteur pour voir **Recherche dans ce projet** avec le résultat effectif.

Les changements s’enregistrent automatiquement. **Par défaut / hérité** utilise la configuration héritée ou le choix natif enregistré ; un remplacement Projet l’emporte sur Global. **Désactivé** coupe la recherche à la portée sélectionnée ; **Fournisseur automatique** demande la sélection automatique native. **Recherche web** ne charge ses connexions et ses choix que lorsque ce groupe est déplié. **Déconnecter** retire une clé de recherche enregistrée ; une connexion fournie par une variable d’environnement est indiquée en lecture seule et n’a pas de **Déconnecter**.

Les identifiants de recherche restent globaux au service même si le choix du fournisseur est propre au Projet. Enregistrer une clé ne la sélectionne pas comme recherche par défaut. Si la lecture/l’enregistrement échoue, actualisez avant de réessayer ; ne remplacez pas la configuration aveuglément. Pour la configuration native, voir la [documentation OpenCode](https://opencode.ai/v2/docs/) et la [configuration d’OpenCode](opencode.md).
