# Mises à jour

## Choisir le flux de versions {#feed}

1. Ouvrez **Paramètres → Info → Mises à jour**.
2. Réglez **Flux de mises à jour** sur **Versions stables** ou **Préversions et versions stables**.
3. Actualisez/recherchez les mises à jour et examinez la version proposée avant d’accepter une installation.

Le flux est enregistré dans la configuration du serveur CodeNomad et change seulement les versions proposées. Il ne change ni profils de données de bureau, brouillons, fenêtres, sessions OpenCode ou configuration du service. Sans sélection explicite, les distributions marquées comme préversions utilisent les préversions par défaut, les autres les versions stables.

Stable sélectionne la dernière version finale. Préversion suit l’ordre de publication car les distributions de développement peuvent partager un numéro de version de base ; ne comparez pas seulement leurs numéros. Une préversion n’est proposée qu’une fois toutes ses distributions publiées. Les paquets de préversion s’adressent aux utilisateurs prêts à tester un comportement préalable à la sortie ; lisez les notes et protégez les brouillons importants avant de redémarrer.

## Mettre à jour une installation de bureau {#desktop-update}

1. Utilisez **Aide → Rechercher des mises à jour…**, la notification de mise à jour ou le bouton dans **Paramètres → Info → Mises à jour**.
2. Sur Electron, suivez la page de version et obtenez l’archive/le paquet correspondant à votre hôte/plateforme.
3. Sur les installations Tauri locales admissibles, examinez la proposition native et choisissez explicitement **Installer et redémarrer**.
4. Enregistrez le travail important de chaque fenêtre avant installation/redémarrage, puis vérifiez **Info** après relancement.

| Installation Tauri | Admissibilité à l’installation dans l’application |
| --- | --- |
| Installation NSIS Windows x64 | Prise en charge avec la clé de mise à jour intégrée et une charge de version signée. |
| Application macOS x64 / arm64 | Prise en charge avec la clé de mise à jour intégrée et une charge `.app.tar.gz` signée. |
| AppImage Linux x64 | Nécessite le marqueur de paquet AppImage et un chemin `APPIMAGE` non vide, ainsi que la prise en charge des mises à jour signées. `APPRUN` seul ne suffit pas. |
| Debian/RPM, exécutable Windows seul, distribution non signée/sans clé | Ouvre la page de version au lieu d’installer dans l’application. |

Dans les fenêtres d’application Tauri et les fenêtres natives de **Préférences**, la carte Mises à jour affiche **Installer la mise à jour** lorsqu’une version est proposée. Elle vérifie le flux sélectionné et propose **Installer et redémarrer** lorsqu’une mise à jour dans l’application est disponible ; sinon, elle ouvre la page de version indiquée sur la carte. Les fenêtres Electron, web et distantes affichent à la place le lien **Télécharger la mise à jour**, sans vérification par le mécanisme natif de mise à jour.

Le menu Tauri **Aide → Rechercher des mises à jour…** lance la procédure de mise à jour dans la fenêtre d’application qui a le focus. Depuis les Préférences ou une fenêtre distante, il ramène au premier plan la fenêtre d’application utilisée le plus récemment pour lancer la vérification ; il n’installe pas via la fenêtre distante. Si aucune fenêtre d’application ne peut recevoir l’action, notamment lorsque la fenêtre ciblée affiche un écran de chargement, de connexion ou d’appairage, le menu ouvre la page de version à la place.

Tauri n’installe que les versions ayant un manifeste de mise à jour publié pour le flux/la cible choisis. Si une version annoncée ne peut pas encore être installée, la notification ouvre sa page à la place. La vérification native de signature est requise avant installation. Les signatures de mise à jour sont distinctes des garanties de notarisation/signature de code du système.

L’installation vide les écritures en attente de toutes les fenêtres et arrête le backend CodeNomad détenu avant de remplacer/redémarrer l’application. Le démon OpenCode détenu indépendamment ne fait pas partie de cet arrêt. Fermer CodeNomad retire malgré tout les fonctions dépendantes du backend jusqu’à son retour ; une session OpenCode qui continue ne garantit pas des services d’interface ininterrompus.

Si une vérification est occupée, attendez l’opération de l’autre fenêtre. Pour les échecs de téléchargement, validation ou arrêt, lisez l’erreur et lancez une nouvelle vérification ; une ancienne notification n’autorise pas à réinstaller des octets périmés. Une installation échouée peut restaurer le backend et recharger les fenêtres, sans rejouer automatiquement l’installation. Si l’installation native est indisponible, utilisez la page de version pour le paquet approprié ; voir [Installation](install.md).

## Mettre à jour un serveur autonome {#standalone-update}

1. Identifiez votre mode de lancement CodeNomad et enregistrez le travail dépendant de ce backend.
2. Arrêtez ce processus serveur CodeNomad par sa commande normale de processus/service.
3. Mettez à jour la même installation de paquet, puis redémarrez avec la configuration et les options voulues.

| Méthode de lancement/installation | Commande de mise à jour |
| --- | --- |
| Lancement npm stable ponctuel | `npx @neuralnomads/codenomad@latest` avec vos options habituelles |
| Installation stable globale | `npm install -g @neuralnomads/codenomad@latest` |
| Installation stable locale | `npm install @neuralnomads/codenomad@latest` dans le répertoire du paquet |
| Lancement ponctuel de préversion | `npx @neuralnomads/codenomad-dev@latest` avec vos options habituelles |
| Installation globale/locale de préversion | Installer `@neuralnomads/codenomad-dev@latest` avec la même forme npm globale/locale |

Un processus déjà actif n’acquiert pas le nouveau code simplement parce que npm l’a installé. Conservez volontairement le même chemin de configuration ; sélectionner un flux dans les paramètres ne remplace pas votre paquet npm et ne change pas automatiquement les noms de paquets stable/préversion. Préservez les options d’authentification/TLS au relancement ; voir [Serveur](server.md).

## Garder la maintenance OpenCode séparée {#opencode-separate}

Mettre à jour CodeNomad n’est pas mettre à jour la CLI OpenCode sélectionnée. Mettre à jour cette CLI n’est pas redémarrer le démon partagé actif. Recharger la configuration native est une autre opération explicite, avec ses propres effets sur les Locations chargées et les demandes.

Les ressources Node/npm de bureau sont fournies avec l’application ; une version de l’application livre leurs mises à jour. Cela ne remplace pas votre Node/npm système, l’environnement interne d’Electron, la webview de plateforme ou le service OpenCode géré indépendamment.

Utilisez **Paramètres → OpenCode** pour sélectionner l’environnement d’exécution, installer/mettre à jour et commander explicitement le service. Consultez [Configuration d’OpenCode](opencode.md) avant de redémarrer ou recharger, surtout si d’autres fenêtres/utilisateurs ou Missions partagent le démon. Ne répétez jamais un prompt ou une modification incertaine simplement parce qu’une mise à jour/reconnexion s’est terminée.
