# Fournisseurs et comptes

L’authentification des fournisseurs appartient au service OpenCode connecté, pas à l’appareil du navigateur ni à un projet CodeNomad. Les préférences d’affichage des modèles, les quotas d’abonnement et les choix de recherche web ont des portées différentes.

## Connecter un fournisseur de modèles ou de recherche {#connect}

1. Ouvrez un espace de travail, puis **Paramètres → Fournisseurs**. **Modèles** est déplié au départ ; dépliez **Recherche web** pour les fournisseurs de recherche. **Images** regroupe les réglages d'images.
2. Dans ce groupe, choisissez **Sélectionner un fournisseur**, puis **Connecter**. Pour un fournisseur de modèles déjà présent dans la liste, utilisez **Ajouter un compte** (+) dans sa ligne, y compris pour sa première connexion.
3. Pour un fournisseur de modèles, effectuez la **Méthode d'authentification** native proposée : clé API, OAuth ou commande. Pour OAuth, utilisez **Ouvrir la page d'autorisation** et ne soumettez un code d’autorisation que si demandé. Les fournisseurs de recherche se connectent avec une clé API.
4. Vérifiez la ligne du fournisseur configuré après la fin.

Les intégrations de recherche seules apparaissent sous **Recherche web**, pas **Modèles**. Enregistrer l’authentification ne choisit pas un modèle et ne change pas le fournisseur de recherche par défaut. Le serveur OpenCode actif enregistre les clés API et identifiants OAuth. Le navigateur reçoit des métadonnées de connexion, pas les secrets enregistrés. Une connexion issue de variables d’environnement est en lecture seule ici : modifiez son environnement propriétaire au lieu de tenter de la déconnecter ici.

Ne publiez pas le lien ou code d’autorisation dans les diagnostics.

## Sélectionner et gérer les comptes {#accounts}

1. Dans la ligne du fournisseur, utilisez **Compte actif** pour sélectionner un identifiant enregistré.
2. Utilisez **Ajouter un compte** pour authentifier une autre connexion.
3. Pour gérer un autre compte enregistré, sélectionnez-le d’abord, puis utilisez **Renommer le compte** ou **Supprimer le compte**. Le renommage utilise **Nom du compte** et **Enregistrer** ; **Supprimer le compte** agit immédiatement, sans confirmation.

La sélection, le renommage et la suppression affectent cette intégration dans tout le service OpenCode, y compris d’autres projets et clients. Retirer un identifiant peut les priver d’authentification ; cela ne supprime pas l’historique et ne révoque pas le compte distant du fournisseur. Les connexions d’environnement ne peuvent pas être sélectionnées comme identifiants enregistrés modifiables ni retirées ici.

### Limites de la sélection automatique {#automatic-selection}

Avec plusieurs identifiants enregistrés sur une intégration prise en charge, **Sélection automatique du compte** active volontairement la sélection par quota avant l’admission du prochain prompt/de la prochaine commande personnalisée via CodeNomad. Ce réglage est propre à chaque intégration dans la configuration CodeNomad ; la sélection de compte résultante s’applique à tout le service.

| Intégration admissible | Type de compte admissible |
| --- | --- |
| OpenAI / Codex | Comptes d’abonnement Codex OAuth par navigateur/appareil, pas les clés OpenAI à l’usage ni la méthode de connexion ChatGPT dont OpenAI ne fournit pas l’utilisation. |
| OpenCode Go | Clé Go, ou connexion/clé OpenCode Console utilisée pour le **fournisseur Go uniquement** ; les modèles payants Console restent manuels. |
| Anthropic | Connexion OAuth Claude Pro/Max d’OpenCode, **pas** la connexion Claude Code. |
| GitHub Copilot | OAuth avec quota de requêtes premium lisible ; les identifiants de points d’accès d’entreprise ne sont pas des candidats lisibles. |
| Offres de codage | À clé : `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Seul un compte courant au quota saturé déclenche un changement ; une alternative disposant de plus de quota ne suffit pas. Codex, Copilot et les offres de codage exigent un candidat manifestement disponible. Go, Console et Claude peuvent utiliser un candidat au quota inconnu sauf si un échec natif récent de quota le marque comme épuisé.

Ce n’est **pas un basculement en cours de requête**. Cela ne réessaie pas les requêtes échouées et ne rejoue ni prompts, ni commandes, ni modifications. Cela ne fait pas tourner les connexions d’environnement, fournisseurs arbitraires, soldes à l’usage ou connexions Claude Code externes.

## Visibilité des modèles, favoris et Réflexion {#models}

1. Choisissez **Gérer les modèles** à côté d’un fournisseur de modèles.
2. Recherchez par nom/ID et changez la visibilité ; **Tout afficher** et **Tout masquer** affectent sa liste de sélection. Faites glisser le pointeur sur les cases pour changer plusieurs modèles d'un coup.
3. Dans le sélecteur **Modèle** d’une conversation, utilisez **Ajouter aux favoris** ou **Retirer des favoris** ; **Afficher tous les modèles** quitte le filtrage limité aux favoris.
4. Utilisez **Réflexion** dans la zone de saisie pour les variantes exposées par le modèle sélectionné.

La visibilité et les favoris organisent les sélecteurs de CodeNomad ; ils ne désinstallent pas les modèles, ne retirent pas les identifiants et n’empêchent pas les autres clients OpenCode de les utiliser. Réflexion sélectionne une variante pour les envois suivants, pas la visibilité du raisonnement déjà présent. Restaurez les modèles masqués avec **Gérer les modèles → Tout afficher**.

## Utilisation, comptes de tokens et connexions expirées {#usage}

Utilisez **Utilisation** dans le panneau droit pour les fenêtres de quota du fournisseur de la conversation active, leurs réinitialisations et les soldes pris en charge. Ces lectures diffèrent des **Tokens** par message et des estimations de coût : un quota d’abonnement n’est pas une facture calculée sur la transcription visible. Une lecture manquante, périmée ou inconnue n’est ni une utilisation nulle ni une preuve de capacité restante. **Solde de crédits du fournisseur** dans **Paramètres → Avancé** contrôle l’affichage complémentaire du solde.

La [FAQ Antigravity](https://antigravity.google/docs/faq/) de Google indique que l’utilisation de logiciels tiers avec une connexion Antigravity enfreint ses conditions et peut entraîner la suspension ou la clôture du compte.

Pour les modèles payants de l’intégration `opencode`, **OpenCode Console** affiche les **Requêtes** sur **24 heures**, **7 jours** et **30 jours**, telles que Console les fournit. **Requêtes par modèle · 30 jours** indique chaque modèle et son fournisseur. Les compteurs couvrent le compte Console connecté et sont formatés selon la langue de l’application. **Budgets des comptes de service** affiche **Budgets indisponibles.** Avec **Solde de crédits du fournisseur** activé, le solde de crédits Console apparaît sous **Crédits**. OpenCode Go utilise son propre lecteur de quota.

Rétablissez une connexion OAuth Console invalide ou expirée via son propriétaire, même si une clé API est aussi enregistrée.

En cas d’erreur de connexion Console (401 ou 403), vérifiez la connexion, son identifiant d’organisation et son autorisation **Usage › Read** dans **Paramètres → Fournisseurs**, puis actualisez **Utilisation**. OAuth exige `https://opencode.ai/console`.

Pour les modèles gratuits OpenCode (`big-pickle` et identifiants finissant par `-free`), **Utilisation** affiche une seule barre : les requêtes gratuites du compte Console connecté sur les dernières 24 heures de Console, sur une référence de **800** ; les limites réelles peuvent varier. Le compteur inclut les autres clients du compte et n’a pas d’heure de réinitialisation. Avec **Solde de crédits du fournisseur** activé, le solde de crédits Console apparaît sous **Crédits**. Connectez OpenCode Console via **Paramètres → Fournisseurs** pour suivre les requêtes des modèles gratuits.

L’utilisation gratuite et les compteurs Console payants servent uniquement à l’affichage ; la sélection automatique de compte utilise ses propres lecteurs et règles.

OpenAI ne fournit pas l’utilisation pour l’une des méthodes de connexion ChatGPT : Utilisation l’indique au lieu d’afficher les fenêtres de quota. Choisissez [Consulter l’utilisation ChatGPT](https://chatgpt.com/settings/usage) pour consulter l’utilisation des applications et gérer leur accès à votre forfait et à vos crédits dans ChatGPT.

Claude via `anthropic`/`claude` utilise l’OAuth Anthropic d’OpenCode. Le fournisseur **Claude Agent** d’OpenCode (`claude-agent`) et le fournisseur `claude-code` utilisent la connexion Claude Code sur l’hôte du démon, y compris sa distribution WSL : `CLAUDE_CODE_OAUTH_TOKEN`, puis la connexion enregistrée, avec `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` ou `~/.claude` déterminant le stockage fichier ; macOS local peut utiliser le Trousseau.

Pour OpenRouter, **Plafond de la clé** affiche le montant restant en USD par rapport au plafond de dépenses de la clé ; une clé sans plafond n’a pas cette ligne. L’utilisation emploie le `baseURL` configuré du fournisseur, préfixe de chemin compris, ou `https://openrouter.ai/api/v1` s’il est absent. Utilisez un nom d’hôte HTTPS public sans identifiants, port explicite, paramètres ni fragment ; les adresses IP et localhost sont refusés. Une URL invalide ou une passerelle sans `/key` rend la lecture indisponible ; la clé reste à la destination configurée et les redirections sont refusées.

Pour GitHub Copilot, **Utilisation** affiche la consommation sous la forme **utilisés / plafond utilisés**, ou les crédits consommés d’un quota illimité lorsque GitHub les fournit ; sinon, **Illimité**. Les connexions Enterprise utilisent `https://api.<hôte>/copilot_internal/user` à partir de l’hôte ou de l’URL HTTPS racine de la connexion enregistrée. Utilisez un nom d’hôte qualifié sans identifiants, port explicite (même `:443`), chemin au-delà de `/`, paramètres ni fragment ; les adresses IP et localhost sont refusés avant l’envoi du jeton. Les redirections sont refusées. Les connexions Enterprise restent exclues de la sélection automatique des comptes.

Kimi prend en charge `kimi-code-plan-cn`, `kimi-code-plan-global`, `kimi-for-coding` et `kimi`. Les plafonds disponibles sur cinq heures, hebdomadaires, **Mensuel** et **Code mensuel** indiquent le pourcentage utilisé.

Les plafonds mensuels suivent la date de réinitialisation du fournisseur ; un compte `kimi-for-coding` ayant épuisé l’un d’eux est indisponible pour la sélection automatique, même si une fenêtre plus courte dispose encore de capacité.

Les clés API OpenCode Go affichent les pourcentages utilisés et les réinitialisations disponibles. La connexion OpenCode Console lit aussi le solde du portefeuille en USD si les droits de facturation le permettent. Activez **Solde de crédits du fournisseur** pour afficher ce solde séparé (désactivé par défaut) ; les quotas Go et Extra Usage restent distincts. Un solde seul laisse le quota inconnu pour la sélection automatique.

Pour **L'utilisation est temporairement indisponible.** ou **Impossible de joindre OpenCode Console.**, vérifiez la connexion réseau et actualisez **Utilisation**.

Si une clé OpenCode Go a expiré, créez-en une dans [OpenCode Console](https://opencode.ai/console/login), sous **Account → Personal API keys**, puis remplacez la clé enregistrée via la connexion du fournisseur.

### Variables d’environnement d’utilisation facultatives {#usage-environment}

Fournissez un jeton d’accès Cursor actuel avec les variables ci-dessous. Les lectures Enterprise nécessitent l’autorisation de lire les données du tableau de bord de l’équipe ; l’[API Admin](https://cursor.com/docs/account/teams/admin-api) utilise une clé d’administration distincte. Actualisez un jeton expiré et redémarrez le backend avec l’environnement mis à jour.

Définissez-les dans l’environnement du **processus backend CodeNomad** avant son lancement. Modifier l’éditeur de session **Variables d'environnement** ne met pas à jour le `process.env` d’un backend actif pour ces lecteurs. Redémarrez le backend dans l’environnement voulu pour les changer ; ne redémarrez pas le service OpenCode partagé uniquement pour une variable de lecture d’utilisation.

| Intégration d’utilisation | Variable d’environnement |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, avec repli sur `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| Utilisation complémentaire OpenCode Go | `OPENCODE_GO_WORKSPACE_ID` et `OPENCODE_GO_AUTH_COOKIE` ensemble |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — clé de plateforme, distincte de la clé d’inférence |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | Repli `COMMAND_CODE_API_KEY` si aucun identifiant natif n’est disponible |

Gardez les jetons/cookies hors de l’historique shell, des captures et des rapports.

## Recherche web par défaut et remplacement Projet {#web-search}

1. Dans **Paramètres → Fournisseurs**, dépliez **Recherche web** et connectez l’intégration de recherche avec sa clé API si elle en nécessite une.
2. Choisissez **Recherche par défaut** pour la configuration Global.
3. Utilisez **Pour le projet courant** pour la remplacer dans la Location active. Survolez ou focalisez ce sélecteur pour voir **Recherche dans ce projet** avec le résultat effectif.

Les changements s’enregistrent automatiquement. **Par défaut / hérité** utilise la configuration héritée ou le choix natif enregistré ; un remplacement Projet l’emporte sur Global. **Désactivé** coupe la recherche à la portée sélectionnée ; **Fournisseur automatique** demande la sélection automatique native. **Déconnecter** retire une clé de recherche enregistrée ; une connexion fournie par une variable d’environnement est indiquée en lecture seule et n’a pas de **Déconnecter**.

Les identifiants de recherche restent globaux au service même si le choix du fournisseur est propre au Projet. Enregistrer une clé ne la sélectionne pas comme recherche par défaut. Pour la configuration native, voir la [documentation OpenCode](https://opencode.ai/v2/docs/) et la [configuration d’OpenCode](opencode.md).

## Génération et stockage d'images {#images}

1. Dans **Paramètres → Fournisseurs**, dépliez **Images**.
2. **Génération d'images** est sur **Activée, modèle automatique** tant que vous ne la changez pas : choisissez plutôt l'un des modèles d'image proposés par vos fournisseurs connectés, ou **Désactivée** pour la désactiver dans la configuration Globale.
3. Cochez **Stocker les images une seule fois** pour conserver chaque image jointe ou générée une seule fois, au lieu de la recopier dans chaque message qui l'utilise.

Les changements sont enregistrés automatiquement dans la configuration OpenCode Globale et s'appliquent à tous les projets. Ce sont des fonctions expérimentales d'OpenCode : **Images** n'affiche que les réglages pris en charge par la version d'OpenCode connectée. Les agents ne disposent de l'outil d'image que si un fournisseur connecté propose un modèle d'image. **Stocker les images une seule fois** s'applique aux nouveaux messages. Si le fichier de configuration OpenCode du projet décide de **Stocker les images une seule fois**, la case affiche la valeur appliquée dans le projet et l'enregistrement l'écrit aussi dans ce fichier. Si l'enregistrement masquait d'autres réglages OpenCode, **Images** reste en lecture seule ; modifiez les options dans le fichier de configuration indiqué par l'infobulle de l'avertissement.

Pour créer, comparer et affiner des images dans une conversation dédiée, consultez [Créer des images avec l’extension Design](extensions.md#design).
