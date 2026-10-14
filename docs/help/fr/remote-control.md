# Contrôle à distance

Le Contrôle à distance permet à un navigateur ou client de bureau appairé d’utiliser votre backend CodeNomad actif sans ouvrir de port réseau entrant. Il ne nécessite ni mot de passe serveur, ni `--host` hors boucle locale, ni VPN. C’est un chemin d’accès distinct des [connexions directes](remote-access.md).

## Démarrer et appairer {#start-and-pair}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant**.
2. Choisissez **Démarrer le contrôle à distance**. Attendez **Prêt pour les connexions distantes** ; la première utilisation peut demander du temps pour provisionner l’identité de tunnel et le certificat.
3. Sous **Connecter un autre appareil**, scannez le QR code ou choisissez **Copier le lien**, puis ouvrez ce lien à usage unique sur l’appareil voulu.
4. Conservez les données de site du navigateur appairé. Rouvrez l’adresse du tunnel pour vous reconnecter tant que le backend est actif.

Le lien est valable **cinq minutes** et réussit **une seule fois**. Traitez-le comme un identifiant : quiconque le consomme peut devenir un appareil appairé. Le code se trouve dans le fragment d’URL, pas dans la chaîne de requête. **Créer un nouveau lien d’appairage** invalide immédiatement le lien inutilisé précédent. L’arrêt, la fermeture du backend et une panne du tunnel annulent les liens d’appairage en attente.

Pour appairer un autre CodeNomad de bureau, ouvrez **Serveurs → Se connecter à un serveur**, collez le lien dans **URL du serveur**, puis choisissez **Se connecter**. Seule l’origine du tunnel est enregistrée comme favori ; le code n’est pas conservé. La vérification TLS reste activée pour les liens d’appairage.

## Gérer les appareils appairés {#paired-devices}

1. Sur l’hôte, revenez à **Paramètres → Accès distant → Contrôle à distance**.
2. Vérifiez **Appareils appairés** et leur heure **Dernière activité**.
3. Choisissez **Révoquer** pour un appareil qui ne doit plus se connecter.

La révocation termine les connexions HTTP/SSE actuelles de cet appareil ainsi que son accès futur. Appairez-le à nouveau avec un nouveau lien pour rétablir l’accès. Un appareil expire après **30 jours sans utilisation**. À la **limite de 32 appareils**, un nouvel appairage remplace l’appareil vu le moins récemment et ferme ses connexions.

Le backend conserve des hachages d’identifiants, pas les identifiants d’appareil bruts, dans `remote-control-devices.json` sous sa base de configuration. Le client détient un cookie d’appareil limité à l’hôte, `Secure`, `HttpOnly`, `SameSite=Lax`. Sa durée côté navigateur peut dépasser la limite serveur de 30 jours d’inactivité ; le registre fait autorité. Effacer les données de site, changer de profil navigateur ou utiliser la navigation privée peut nécessiter un nouvel appairage.

Changer le mot de passe d’accès direct ne révoque **pas** les appareils. **Arrêter le contrôle à distance** déconnecte le tunnel mais conserve la liste des appareils ; utilisez **Révoquer** pour retirer une autorisation.

### Réappairer sans perdre sa place {#re-pair}

1. Si le client indique que l’appareil n’est plus appairé, laissez cette page ouverte.
2. Sur l’hôte, choisissez **Créer un nouveau lien d’appairage** et ouvrez-le dans le **même navigateur/profil client**. Pour un serveur de bureau enregistré, reconnectez-vous avec le lien récent afin de réutiliser le stockage existant de sa fenêtre distante.
3. Revenez à la page en attente et vérifiez de nouveau l’authentification.

La récupération préserve la page ouverte et les brouillons ; elle ne rejoue pas une action échouée. Vérifiez si un envoi, une réponse ou une suppression a pris effet avant de réessayer. Un mot de passe d’accès direct ne peut pas récupérer un appairage de Contrôle à distance.

## Disponibilité et durée de vie {#lifetime}

| Action/état | Effet |
| --- | --- |
| Démarrer le contrôle à distance | Connecte ce backend et mémorise le choix pour les prochains lancements. |
| Fermer le navigateur distant | N’arrête pas le backend hôte et ne révoque pas l’appareil. |
| Arrêter le contrôle à distance | Déconnecte l’accès et efface la reprise automatique au lancement ; conserve les appareils enregistrés. |
| Arrêt du backend / fermeture de la dernière fenêtre de bureau et sortie de l’application | Le Contrôle à distance passe hors ligne. Le service OpenCode partagé peut rester actif, mais ne peut pas servir cette interface via un backend arrêté. |
| Lancement après avoir laissé le Contrôle à distance démarré | Reconnecte en arrière-plan sans émettre de nouveau lien. Les installations jamais démarrées ne s’activent pas d’elles-mêmes. |
| Reprise échouée ou erreur fatale du tunnel | Le choix mémorisé reste ; consultez **Actualiser** sur l’hôte. **Arrêter le contrôle à distance** l’efface ; un lancement ultérieur réessaie s’il reste activé. |

La reprise automatique au lancement se limite à un backend par répertoire de configuration. Ne démarrez pas d’hôtes concurrents avec la même configuration pour obtenir une capacité de tunnel supplémentaire. Pour un hôte devant rester accessible après la fermeture du bureau, déployez un [serveur autonome](server.md) géré séparément ; le Contrôle à distance n’est pas un démon indépendant.

## Surfaces disponibles et indisponibles {#remote-surface}

Les appareils appairés peuvent utiliser les API ordinaires de projet/conversation, envoyer des prompts, inspecter les fichiers et répondre aux permissions/Forms sous les mêmes contrôles de propriété. L’appairage donne un accès puissant, pas un lien de partage en lecture seule. Il n’accorde jamais les privilèges de boucle locale, même si le tunnel transfère le trafic en interne sur l’hôte.

| Surface | Via le Contrôle à distance |
| --- | --- |
| Interface authentifiée normale, espaces de travail, conversations et SSE | Disponible à un appareil appairé. |
| Connexion/déconnexion par mot de passe, changements de mot de passe, initialisation locale par jeton | Indisponibles ; les identifiants d’appareil sont requis même si l’authentification directe est désactivée. |
| État du Contrôle à distance | Lisible par un appareil appairé ; la gestion est indisponible. Démarrage/arrêt, création d’appairage, liste et révocation des appareils restent sur le chemin d’accès de l’hôte. |
| Gestion des fenêtres distantes/serveurs de bureau et routes proxy | Indisponibles (`/api/remote-servers/`, `/api/remote-proxy/`). |
| **Proxy de contenu** SideCar | Indisponible (`/sidecars/`). Cela ne signifie **pas** que toutes les API SideCar sont bloquées : les clients appairés peuvent toujours accéder aux API d’enregistrement `/api/sidecars`. |
| Contenu d’aperçu et pont d’automatisation | Indisponibles (`/previews/`, `/api/opencode-plugin/`). Les capacités natives de bureau ne deviennent pas des capacités navigateur. |
| Mises à niveau WebSocket | Indisponibles sur l’entrée du Contrôle à distance. |

Utilisez une [connexion directe](remote-access.md) convenablement protégée si un parcours nécessite une surface proxy/WebSocket bloquée. Le Contrôle à distance ne bascule pas automatiquement vers ce chemin.

## Relais et confidentialité {#relay-privacy}

CodeNomad utilise [OpenTunnel](https://github.com/anomalyco/opentunnel) et réserve une route aléatoire sur l’identité de tunnel par défaut partagée de la machine. L’arrêt libère le pont CodeNomad, pas l’identité partagée utilisée par d’autres applications.

TLS se termine dans le backend CodeNomad. Le relais transfère du texte chiffré et ne peut pas lire le contenu applicatif, mais peut observer les noms d’hôte, horaires de connexion et volumes de trafic. Le certificat/la clé privée du tunnel restent sur l’hôte. Protégez le stockage du tunnel et la configuration CodeNomad comme des identifiants ; une adresse impossible à deviner n’est pas une autorisation.

`CODENOMAD_REMOTE_CONTROL_API` sélectionne une API OpenTunnel auto-hébergée ; non définie, elle utilise le service hébergé. Cela change le déploiement du tunnel, pas les exigences d’appairage ni les surfaces bloquées. Voir [Sécurité](security.md) pour le traitement des identifiants et diagnostics.
