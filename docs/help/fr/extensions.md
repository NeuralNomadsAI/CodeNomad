# Extensions de panneau

## Parcourir les extensions installées et en ligne {#browse}

1. Ouvrez **Personnaliser le panneau droit** dans la barre d’onglets du panneau droit.
2. Développez **Extensions** sous le séparateur.
3. Utilisez **Rechercher des extensions** pour chercher dans la liste unique des modules installés et du catalogue officiel en ligne. Survolez ou focalisez une entrée pour ses métadonnées.

La section commence repliée à chaque ouverture du menu de personnalisation. Les entrées installées et en ligne sont combinées par ID d’extension ; il n’existe ni fenêtre de gestion séparée ni mode installé/en ligne. Parcourir les métadonnées du catalogue ne télécharge ni n’exécute le code de panneau de l’auteur. Le catalogue est maintenu dans [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions) ; la présence dans celui-ci et les noms d’auteur revendiqués ne sont ni des signatures ni des preuves de confiance.

Si le catalogue est indisponible, les extensions installées et **Installer depuis un ZIP…** restent disponibles. Actualisez pour réessayer la découverte. Replier ou fermer le menu abandonne son interface de revue/confirmation en attente ; cela n’installe rien silencieusement.

## Examiner et installer sans activer {#install}

1. Choisissez **Installer…** sur une entrée du catalogue, ou **Installer depuis un ZIP…** pour un paquet obtenu séparément.
2. Vérifiez l’ID du paquet, l’auteur, le dépôt, la version, l’API/les permissions et l’empreinte SHA-256. Développez les détails techniques au besoin.
3. Vérifiez l’éditeur et, si possible, comparez l’empreinte par un canal de confiance.
4. Seulement si vous faites confiance au code, sélectionnez **Je fais confiance à ce paquet et à son auteur**, puis **Installer sans activer**.

L’inspection télécharge/revalide le paquet sélectionné ; elle n’exécute pas le code de l’auteur. Une empreinte identifie des octets exacts, pas l’identité de l’auteur. Les paquets du catalogue viennent de l’élément de version GitHub exact déclaré, pas d’une URL arbitraire. Les paquets manuels sont des ZIP contenant uniquement `manifest.json` et un `panel.html` autonome ; les paquets invalides ou non pris en charge sont refusés.

L’installation ne nécessite pas de redémarrage OpenCode et n’accorde jamais automatiquement l’activation. Un échec de validation, conflit ou opération de stockage n’autorise pas à réessayer avec d’autres octets. Réinspectez le paquet avant une nouvelle tentative d’installation.

## Activer et comprendre la portée {#activate-scope}

1. Revenez à la ligne du module au-dessus de la section **Extensions** dans **Personnaliser le panneau droit**. Les modules installés désactivés restent dans cette liste.
2. Cochez sa case pour l’activer. Décochez cette même case pour le désactiver.

Cette case est l’unique commande d’activation : aucun commutateur de gestion supplémentaire ni filtre de visibilité par fenêtre. L’activation concerne tous les projets de la configuration, pas un dossier. Sur une connexion distante, elle affecte le stockage d’extensions du serveur, pas seulement votre appareil d’affichage.

Le stockage d’extensions est `panel-extensions/` à côté de la configuration CodeNomad sélectionnée. Des profils de données de bureau séparés n’isolent **pas** les extensions s’ils utilisent le même répertoire de configuration. Inversement, ouvrir une autre configuration n’autorise pas l’exécution d’un module installé ailleurs. Voir [Fenêtres de bureau et données](desktop.md) pour cette distinction.

Un panneau activé peut être monté à sa sélection ; le masquer peut libérer son état d’interface temporaire. Le désactiver révoque son activation. **Réinitialiser** dans la personnalisation restaure seulement la disposition intégrée et n’active, ne désactive ni ne désinstalle les extensions.

## Remplacer ou supprimer {#replace-remove}

1. Utilisez **Changer de version…** ou inspectez un autre ZIP de même ID pour remplacer un paquet installé.
2. Vérifiez la nouvelle empreinte et les permissions, confirmez la confiance puis installez-le sans l’activer.
3. Réactivez-le via la case normale seulement après avoir décidé de faire confiance au remplacement.
4. Pour désinstaller, utilisez **Supprimer…** et **Confirmer la suppression** après vérification de la cible.

Chaque remplacement révoque l’activation dans tous les projets, même si les permissions sont inchangées. Un échec de validation/conflit/stockage préserve le paquet installé. Aucune mise à jour d’extension silencieuse n’existe. La suppression retire le paquet et ses réglages d’activation, pas les sessions OpenCode ni fichiers du projet. Pour récupérer après du code indésirable, désactivez-le d’abord ; ne réinstallez qu’un paquet vérifié et fiable.

## Contexte, consentement aux ressources et limites du bac à sable {#permissions-sandbox}

| Contrat | Ce que l’activation permet |
| --- | --- |
| API 1 / `session.context` | Identifiant de session courante (ou aucun), langue et apparence d’interface. Aucun texte de transcription ni accès aux fichiers. |
| API 2 / `session.assets.read` plus contexte | Permission explicitement examinée pour lister des métadonnées bornées d’images de résultats d’outils/pièces jointes de la session courante et lire les octets intégrés pris en charge. Ce n’est pas un accès général aux transcriptions, fichiers ou URL. |

L’accès aux ressources suit l’hôte/la session actuellement monté, pas une session choisie par l’auteur. Des références locales/distantes peuvent être listées comme indisponibles ; l’API de ressources ne récupère pas d’URL distantes arbitraires et n’ouvre pas de fichiers locaux. Changer de session, déconnecter ou révoquer le consentement invalide l’ancien accès.

Le code de l’auteur s’exécute dans une iframe restreinte, pas dans le moteur de rendu de confiance de l’application. Il ne reçoit aucun pont natif/OpenCode, accès aux identifiants, RPC général, formulaire, fenêtre surgissante ou téléchargement ; les API réseau et ressources externes sont restreintes. Les extensions sont des modules d’interface, pas des [plugins OpenCode](integrations.md).

Le bac à sable n’est pas une isolation de processus/CPU ni une promesse d’innocuité du code approuvé. Une extension hostile peut perturber son moteur de rendu. N’installez que des auteurs de confiance, ne fournissez pas de secrets et désactivez/supprimez un module au comportement inattendu.
