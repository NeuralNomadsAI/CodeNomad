# Extensions de panneau

## Parcourir les extensions installées et en ligne {#browse}

1. Ouvrez **Personnaliser le panneau droit** dans la barre d’onglets du panneau droit.
2. Développez **Extensions** sous le séparateur.
3. Utilisez **Rechercher des extensions** pour chercher dans la liste unique des modules installés et du catalogue officiel en ligne. Survolez ou focalisez une entrée pour ses métadonnées.

Parcourir les métadonnées du catalogue ne télécharge ni n’exécute le code de panneau de l’auteur. Le catalogue est maintenu dans [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions) ; la présence dans celui-ci et les noms d’auteur revendiqués ne sont ni des signatures ni des preuves de confiance.

## Examiner et installer sans activer {#install}

1. Choisissez **Installer…** sur une entrée du catalogue, ou **Installer depuis un ZIP…** pour un paquet obtenu séparément.
2. Vérifiez l’ID du paquet, l’auteur, le dépôt, la version, l’API/les permissions et l’empreinte SHA-256. Développez les détails techniques au besoin.
3. Vérifiez l’éditeur et, si possible, comparez l’empreinte par un canal de confiance.
4. Seulement si vous faites confiance au code, sélectionnez **Je fais confiance à ce paquet et à son auteur**, puis **Installer sans activer**.

L’inspection télécharge/revalide le paquet sélectionné ; elle n’exécute pas le code de l’auteur. Une empreinte identifie des octets exacts, pas l’identité de l’auteur. Les paquets du catalogue viennent de l’élément de version GitHub exact déclaré, pas d’une URL arbitraire. Les paquets manuels sont des ZIP contenant uniquement `manifest.json` et un `panel.html` autonome ; les paquets invalides ou non pris en charge sont refusés.

L’installation ne nécessite pas de redémarrage OpenCode et n’accorde jamais automatiquement l’activation.

## Activer et comprendre la portée {#activate-scope}

1. Revenez à la ligne du module au-dessus de la section **Extensions** dans **Personnaliser le panneau droit**. Les modules installés désactivés restent dans cette liste.
2. Cochez sa case pour l’activer. Décochez cette même case pour le désactiver.

L’activation concerne tous les projets de la configuration, pas un dossier. Sur une connexion distante, elle affecte le stockage d’extensions du serveur, pas seulement votre appareil d’affichage.

Le stockage d’extensions est `panel-extensions/` à côté de la configuration CodeNomad sélectionnée. Des profils de données de bureau séparés n’isolent **pas** les extensions s’ils utilisent le même répertoire de configuration. Voir [Fenêtres de bureau et données](desktop.md) pour cette distinction.

**Réinitialiser** dans la personnalisation restaure seulement la disposition intégrée et n’active, ne désactive ni ne désinstalle les extensions.

## Remplacer ou supprimer {#replace-remove}

1. Utilisez **Changer de version…** ou inspectez un autre ZIP de même ID pour remplacer un paquet installé.
2. Vérifiez la nouvelle empreinte et les permissions, confirmez la confiance puis installez-le sans l’activer.
3. Réactivez-le via la case normale seulement après avoir décidé de faire confiance au remplacement.
4. Pour désinstaller, utilisez **Supprimer…** et **Confirmer la suppression** après vérification de la cible.

Chaque remplacement révoque l’activation dans tous les projets, même si les permissions sont inchangées, et efface les réglages enregistrés propres au panneau. Aucune mise à jour d’extension silencieuse n’existe. La suppression retire le paquet, ses réglages d’activation et ses réglages de panneau enregistrés, pas les sessions OpenCode ni fichiers du projet. Pour récupérer après du code indésirable, désactivez-le d’abord ; ne réinstallez qu’un paquet vérifié et fiable.

## Contexte, consentement aux ressources et limites du bac à sable {#permissions-sandbox}

| Contrat | Ce que l’activation permet |
| --- | --- |
| API 1 / `session.context` | Identifiant de session courante (ou aucun), langue et apparence d’interface. Aucun texte de transcription ni accès aux fichiers. |
| API 2 / `session.assets.read` plus contexte | Permission explicitement examinée pour lister des métadonnées bornées d’images de résultats d’outils/pièces jointes de la session courante et lire les octets intégrés pris en charge. Ce n’est pas un accès général aux transcriptions, fichiers ou URL. |
| API 3 / `repository.workItems.read` plus le contexte | Permission examinée explicitement pour lister des pages bornées d’issues et de pull requests du dépôt du projet sur GitHub, GitLab ou Gitea/Forgejo, et en ouvrir une dans le navigateur. Ce n’est pas un accès aux fichiers, aux identifiants ni au réseau en général. |
| API 4 / contexte plus une ou plusieurs des permissions ci-dessous | L’examen liste une phrase par permission déclarée ; l’activation les accorde toutes ensemble, et un remplacement les révoque toutes. |
| `session.images.read` | Lire les images renvoyées par l’outil read dans la conversation affichée, avec leur état de génération et leur filiation lorsqu’ils peuvent être vérifiés. |
| `session.images.prompts` (nécessite `session.images.read`) | Lire le prompt et le modèle de chaque image générée dans la conversation Images du projet. |
| `composer.prefill` | Ajouter du texte à la zone de saisie de la conversation affichée. N’envoie jamais de message. |
| `images.conversation` | Ouvrir ou démarrer la conversation Images de ce projet. |
| `opencode.designAgent` | Ajoute l’agent Design de CodeNomad et ses compétences d’image à OpenCode tant que cette extension est activée. |
| `panel.preferences` | Mémoriser les réglages propres à ce panneau. |
| `panel.notes` | Garder une note par conversation de ce projet, les lister, les supprimer et ouvrir leurs conversations. Retirer l’extension efface les notes. |
| `repository.workItems.read` | Lire le nom du dépôt de ce projet et ses issues et pull requests sur GitHub, GitLab ou Gitea/Forgejo (via votre gh, glab ou tea connecté, ou anonymement pour les dépôts publics), et les ouvrir dans votre navigateur. |
| `repository.worktrees.read` (nécessite `repository.workItems.read`) | Voir quelles issues et pull requests ont une branche locale créée par CodeNomad, et si un worktree l’utilise. |
| `repository.worktrees.write` (nécessite `repository.worktrees.read`) | Demander de créer une branche et un worktree pour une issue ou une pull request (en récupérant la pull request depuis le dépôt) et d’y déplacer la conversation affichée. CodeNomad vous le demande à chaque fois. |

L’accès aux ressources suit l’hôte/la session actuellement monté, pas une session choisie par l’auteur. Changer de session, déconnecter ou révoquer le consentement invalide l’ancien accès.

Une extension disposant de `session.images.prompts` peut lire les prompts que vous ou l’agent avez écrits pour des images dans une conversation Images, et pourrait les transmettre malgré le bac à sable ; ne l’accordez donc qu’à des auteurs à qui vous les confiez. Le texte ajouté par `composer.prefill` reste dans la zone de saisie jusqu’à ce que vous le modifiiez ou sélectionniez **Envoyer le message** ; il ne commence jamais par une commande, ne se termine jamais par une mention `@` ouverte et cite les chemins d’images en texte brut. Annuler avec Ctrl+Z (Cmd+Z sur macOS) dans la zone de saisie ne le retire pas. Les réglages de panneau enregistrés appartiennent à ce profil CodeNomad, 4 Kio au maximum par extension ; désactiver une extension les conserve. Les notes gardées avec `panel.notes` appartiennent aussi à ce profil, classées par projet : les worktrees d’un même dépôt les partagent, de même que ses clones dont le remote désigne le même dépôt hébergé. Désactiver ou remplacer l’extension les conserve, la retirer les supprime. Comme la mémoire de l’agent, les notes ont besoin de Git pour identifier leur projet.

Les éléments viennent du remote `upstream` du dossier du projet, sinon d’`origin`. CodeNomad les lit avec la CLI GitHub, GitLab ou Gitea à laquelle vous êtes déjà connecté (`gh`, `glab`, `tea`), ou anonymement pour les dépôts publics, et ne stocke aucun jeton ; l’extension ne voit que le nom du dépôt et les éléments. La lecture anonyme couvre github.com, gitlab.com, codeberg.org et gitea.com ; une forge auto-hébergée n’est lue que via sa CLI connectée à elle. Ouvrir un élément demande à CodeNomad d’ouvrir sa page sur la même forge dans votre navigateur, au plus une fois par seconde ; l’extension ne peut pas ouvrir d’autres adresses.

Une branche liée est une branche créée par CodeNomad pour un élément : `issue-N` depuis le commit actuel, ou `pr-N` à la tête de la pull request récupérée depuis le même remote, forks compris. Git garde le lien avec la branche et le supprime avec elle ; une branche du même nom que CodeNomad n’a pas créée n’est jamais réutilisée. Une extension peut seulement demander : CodeNomad affiche son propre dialogue nommant l’élément, puis crée la branche et le worktree si besoin et y déplace la conversation affichée et ses conversations de sous-agents. Une branche `pr-N` n’a pas d’upstream ; poussez-la avec votre commande Git habituelle.

Le code de l’auteur s’exécute dans une iframe restreinte, pas dans le moteur de rendu de confiance de l’application. Il ne reçoit aucun pont natif/OpenCode, accès aux identifiants, RPC général, formulaire, fenêtre surgissante ou téléchargement ; les API réseau et ressources externes sont restreintes. Les extensions sont des modules d’interface, pas des [plugins OpenCode](integrations.md).

Le bac à sable n’est pas une isolation de processus/CPU ni une promesse d’innocuité du code approuvé. Une extension hostile peut perturber son moteur de rendu. N’installez que des auteurs de confiance, ne fournissez pas de secrets et désactivez/supprimez un module au comportement inattendu.

## Créer des images avec l’extension Design {#design}

L’extension **Design** est une table lumineuse pour les images que vous créez avec l’agent Design de CodeNomad dans la **conversation Images** d’un projet. Elle affiche les images, prépare des demandes dans la zone de message et laisse chaque génération aux messages que vous envoyez.

1. Connectez un fournisseur qui propose un modèle d’image. La génération d’images est activée, sauf si elle a été désactivée dans **Paramètres → Fournisseurs → Images** ([Génération et stockage d'images](providers.md#images)).
2. Dans **Personnaliser le panneau droit → Extensions**, installez **Design** depuis le catalogue ([Examiner et installer sans activer](#install)) après avoir examiné ses permissions ([Contexte, consentement aux ressources et limites du bac à sable](#permissions-sandbox)), puis cochez sa case ([Activer et comprendre la portée](#activate-scope)).
3. Ouvrez le panneau **Design** et choisissez **Ouvrir la conversation Images**.

Tant que l’extension est activée, CodeNomad ajoute à OpenCode son agent Design et ses compétences d’image. Votre propre agent `design` et vos propres compétences `design-*` restent toujours prioritaires ; quand vous fournissez votre propre agent `design`, le panneau affiche **Votre propre agent Design est utilisé.**

### Conversation Images {#design-conversation}

Chaque dossier de projet ou worktree a sa propre conversation Images, intitulée **Images**. **Ouvrir la conversation Images** la retrouve, ou la crée avec l’agent Design et le modèle que CodeNomad choisit pour une nouvelle conversation avec cet agent, puis l’affiche avec le focus dans la zone de message ; l’ouvrir n’envoie rien. Une conversation Images existante garde son propre modèle. **Nouvelle conversation Images** en démarre une autre avec une table lumineuse vide, et le panneau la suggère dès qu’une conversation contient beaucoup d’images ; **Ouvrir** affiche ensuite la plus récente. Les conversations Images archivées ou supprimées sont ignorées.

Décrivez votre besoin et envoyez-le : l’agent pose quelques questions de cadrage, annonce combien d’images il va générer, les génère, relit chacune et la critique. Les images sont enregistrées dans `.codenomad/design/` du dossier du projet. CodeNomad ajoute ce dossier aux exclusions Git locales du dépôt (`.git/info/exclude`) et laisse le `.gitignore` intact ; quand il ne le peut pas, le panneau affiche **Les images de cet emplacement peuvent apparaître dans Git.** Annuler un tour retire ses images de la table lumineuse mais garde leurs fichiers, et une image que l’agent a écrasée est irrécupérable.

Si le modèle de chat de la conversation ne reçoit pas les images, le panneau avertit que l’agent ne peut pas les critiquer visuellement ; les images qu’il relit restent sur la table lumineuse.

### Table lumineuse {#design-light-table}

La **Table lumineuse** montre les images que l’agent a relues dans la conversation affichée, de la plus récente à la plus ancienne, groupées par réponse. Sélectionner une image l’agrandit avec des aperçus **Petites tailles** à 16, 32 et 64 px ; **Comparer** place deux images côte à côte, et **Voir en taille réelle** ouvre une visionneuse. Dans un panneau étroit, élargissez-le pour comparer. La lignée (**Créée à partir de**, **Utilisée pour**) et, dans la conversation Images, le prompt et le modèle n’apparaissent que si CodeNomad peut vérifier quelle génération a produit l’image ; sinon l’image garde ses pixels et indique **origine non vérifiable**. **Générations** liste chaque génération d’image avec son état ; suivez sa progression dans la conversation. Dans une autre conversation, le panneau montre les images relues de cette conversation, sans prompts ni demandes, et propose d’ouvrir la conversation Images.

Dans la conversation Images, **Partir de** (une recette comme une icône d’app ou un logo), **Affiner**, **Variantes**, **Appliquer la direction**, **Enregistrer dans le projet…**, **Demander à l’agent de l’afficher** et **Réessayer** ajoutent seulement un texte modifiable à la zone de message : le panneau n’envoie jamais de message et ne génère jamais d’image. Les actions portant sur une image choisie citent son chemin relatif au projet, et seules les images du projet dont l’origine est vérifiable peuvent être citées. Modifiez la demande, puis envoyez-la vous-même. **Enregistrer dans le projet…** demande à l’agent de copier l’image vers la destination que vous tapez après la demande. **Images par tour** (1 à 4, 3 par défaut) est repris dans les demandes qui génèrent de nouvelles images et conservé dans les réglages enregistrés du panneau. Sur téléphone, le panneau flotte et se ferme quand il ajoute une demande.

### Utiliser l’agent Design sans CodeNomad {#design-without-codenomad}

L’agent Design et ses compétences sont des fichiers OpenCode ordinaires. Pour les utiliser dans le TUI d’OpenCode ou un autre client sans CodeNomad, copiez le contenu du [dossier de contenu Design](../../../packages/server/src/opencode/design/opencode/) dans le dossier `.opencode/` d’un projet ou dans votre dossier de configuration OpenCode globale (`~/.config/opencode/`), en gardant `NOTICE.md` et la licence à côté. Sélectionnez ensuite l’agent **design** ; il charge ses compétences par leur nom, et les autres agents ne les utilisent que si vous les nommez.

L’agent Design et ses compétences adaptent des éléments d’[Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) et de [taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT) ; `NOTICE.md` liste chaque fichier adapté. L’extension Design reprend du code de l’extension MCP Assets (MIT).
