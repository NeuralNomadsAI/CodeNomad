# Contrôle à distance

Le Contrôle à distance permet à un navigateur ou client de bureau appairé d’utiliser votre backend CodeNomad actif sans ouvrir de port réseau entrant. Il ne nécessite ni mot de passe serveur, ni `--host` hors boucle locale, ni VPN. C’est un chemin d’accès distinct des [connexions directes](remote-access.md).

## Démarrer et appairer {#start-and-pair}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant**.
2. Choisissez **Démarrer le contrôle à distance**. Attendez **Prêt pour les connexions distantes** ; la première utilisation peut demander du temps pour provisionner l’identité de tunnel et le certificat.
3. Sous **Connecter un autre appareil**, scannez le QR code ou choisissez **Copier le lien**, puis ouvrez ce lien à usage unique sur l’appareil voulu.
4. Conservez les données de site du navigateur appairé. Rouvrez l’adresse du tunnel pour vous reconnecter tant que le backend est actif.

Le lien est valable **cinq minutes** et réussit **une seule fois**. Traitez-le comme un identifiant : quiconque le consomme peut devenir un appareil appairé. Le code se trouve dans le fragment d’URL, pas dans la chaîne de requête. **Créer un nouveau lien d’appairage** invalide immédiatement le lien inutilisé précédent. La fermeture du backend annule le lien d’appairage en attente ; l’arrêt et une panne du tunnel annulent un lien de tunnel.

Sur un autre CodeNomad de bureau, collez le lien d’appairage dans **Paramètres → Serveurs → Adresse ou lien du serveur**.

Pour refaire l’appairage, collez le nouveau lien dans le formulaire de connexion du serveur ou du projet.

## Appairer en HTTPS direct {#direct-https}

Lorsque le tunnel est bloqué mais que le backend est joignable en HTTPS de confiance, par exemple derrière un proxy inverse doté d’un vrai certificat, les appareils peuvent s’appairer sur cette adresse. Les adresses admises sont les adresses HTTPS propres à ce backend et les origines HTTPS de `CODENOMAD_ALLOWED_ORIGINS` (voir [Origines autorisées](remote-access.md#upgrading)) ; les noms de boucle locale et le HTTP simple ne s’appairent jamais. Le Contrôle à distance n’a pas besoin d’être démarré.

1. Sur l’hôte, ouvrez **Paramètres → Accès distant → Contrôle à distance**.
2. Sous **Appairage HTTPS direct**, choisissez l’**Adresse HTTPS** si plusieurs sont proposées, puis **Créer un lien d’appairage HTTPS**.
3. Ouvrez le lien sur l’appareil, comme un lien de tunnel. Vous pouvez cliquer dessus depuis une autre page.

Le lien suit les mêmes règles de cinq minutes et d’usage unique, et remplace tout lien inutilisé ; les codes erronés répétés sont limités. Un proxy inverse doit terminer un TLS de confiance, transmettre les en-têtes `Host` et `Origin` d’origine et joindre le backend par la boucle locale ou un réseau protégé.

Un tel appareil se connecte uniquement par son adresse HTTPS, jamais par le tunnel, et **Appareils appairés** affiche cette adresse sous son nom. Arrêter le Contrôle à distance n’annule pas le lien et ne déconnecte pas ces appareils ; **Révoquer**, 30 jours sans utilisation, la limite de 32 appareils ou le retrait de l’adresse de la configuration mettent fin à leur accès. Un navigateur présentant un identifiant d’appareil révoqué ou expiré sur cette adresse ne peut pas revenir au mot de passe du serveur : appairez-le à nouveau, ou effacez les données du site pour vous connecter avec le mot de passe.

Voir les [fonctions disponibles](#remote-surface), dont l’exception HTTPS directe pour le contenu SideCar. L’appairage ne donne aucun privilège de boucle locale, même via un proxy sur l’hôte.

## Gérer les appareils appairés {#paired-devices}

1. Sur l’hôte, revenez à **Paramètres → Accès distant → Contrôle à distance**.
2. Vérifiez **Appareils appairés** et leur heure **Dernière activité**. Chaque appareil porte le nom de la plateforme et du navigateur qui l’ont appairé, par exemple `iPhone · Safari`.
3. Choisissez **Révoquer** pour un appareil qui ne doit plus se connecter. Si **Révocation en attente** s’affiche, choisissez de nouveau **Révoquer** avant de redémarrer l’hôte.

La révocation termine les connexions HTTP/SSE actuelles de cet appareil ainsi que son accès futur. Appairez-le à nouveau avec un nouveau lien pour rétablir l’accès. Un appareil expire après **30 jours sans utilisation**. À la **limite de 32 appareils**, un nouvel appairage remplace l’appareil vu le moins récemment et ferme ses connexions.

Effacer les données de site, changer de profil navigateur ou utiliser la navigation privée peut nécessiter un nouvel appairage.

Changer le mot de passe d’accès direct ne révoque **pas** les appareils. **Arrêter le contrôle à distance** déconnecte le tunnel mais conserve la liste des appareils ; utilisez **Révoquer** pour retirer une autorisation.

### Réappairer sans perdre sa place {#re-pair}

1. Si le client affiche **Appairer à nouveau cet appareil**, laissez cette page ouverte.
2. Sur l’hôte, créez un lien pour la connexion d’origine : **Créer un nouveau lien d’appairage** pour le tunnel, ou sélectionnez l’**Adresse HTTPS** d’origine sous **Appairage HTTPS direct**, puis **Créer un lien d’appairage HTTPS**. Ouvrez-le dans le **même navigateur/profil client**. Une fenêtre distante séparée réutilise son stockage.
3. Revenez à la page en attente et choisissez **Vérifier la connexion** ; la vérification se refait aussi quand la page reprend le focus.

La récupération préserve la page ouverte et les brouillons ; elle ne rejoue pas une action échouée. Vérifiez si un envoi, une réponse ou une suppression a pris effet avant de réessayer. Un mot de passe d’accès direct ne peut pas récupérer un appairage de Contrôle à distance.

## Disponibilité et durée de vie {#lifetime}

| Action/état | Effet |
| --- | --- |
| Démarrer le contrôle à distance | Connecte ce backend et mémorise le choix pour les prochains lancements. |
| Fermer le navigateur distant | N’arrête pas le backend hôte et ne révoque pas l’appareil. |
| Arrêter le contrôle à distance | Déconnecte l’accès par le tunnel et efface la reprise automatique au lancement ; conserve les appareils enregistrés. |
| Arrêt du backend / fermeture de la dernière fenêtre de bureau et sortie de l’application | Le Contrôle à distance passe hors ligne. Le service OpenCode partagé peut rester actif, mais ne peut pas servir cette interface via un backend arrêté. |
| Lancement après avoir laissé le Contrôle à distance démarré | Reconnecte en arrière-plan sans émettre de nouveau lien. Les installations jamais démarrées ne s’activent pas d’elles-mêmes. |

La reprise automatique au lancement se limite à un backend par répertoire de configuration. Ne démarrez pas d’hôtes concurrents avec la même configuration pour obtenir une capacité de tunnel supplémentaire. Pour un hôte devant rester accessible après la fermeture du bureau, déployez un [serveur autonome](server.md) géré séparément ; le Contrôle à distance n’est pas un démon indépendant.

## Surfaces disponibles et indisponibles {#remote-surface}

Les appareils appairés peuvent utiliser les API ordinaires de projet/conversation, envoyer des prompts, inspecter les fichiers et répondre aux permissions/Forms sous les mêmes contrôles de propriété. L’appairage donne un accès puissant, pas un lien de partage en lecture seule. Il n’accorde jamais les privilèges de boucle locale, même si le tunnel transfère le trafic en interne sur l’hôte.

| Surface | Via le Contrôle à distance |
| --- | --- |
| Interface authentifiée normale, espaces de travail, conversations et SSE | Disponible à un appareil appairé. |
| Connexion/déconnexion par mot de passe, changements de mot de passe, initialisation locale par jeton | Indisponibles ; les identifiants d’appareil sont requis même si l’authentification directe est désactivée. |
| État du Contrôle à distance | Lisible par un appareil appairé ; la gestion est indisponible. Démarrage/arrêt, création d’appairage, liste et révocation des appareils restent sur le chemin d’accès de l’hôte. |
| Serveurs enregistrés et relais | Les clients distants authentifiés peuvent utiliser/gérer tous les serveurs enregistrés sur l’hôte si la fonction et ses capacités l’autorisent. Les nouveaux mots de passe/liens d’appairage nécessitent le Contrôle à distance ou HTTPS, pas le HTTP simple sur le réseau local. Voir [Serveurs enregistrés](remote-access.md#saved-servers). |
| Fenêtres distantes de bureau et leur proxy | Réservés à l’hôte (`/api/remote-proxy/`). |
| Contenu SideCar et WebSockets (`/sidecars/`) | Indisponibles via le tunnel. Utilisez la boucle locale ou activez [l’accès direct HTTPS aux SideCars](browser-sidecars.md#register-sidecar) sur l’hôte. |
| Enregistrement SideCar (`/api/sidecars`) | Disponible pour les appareils appairés et les clients directs authentifiés. |
| Contenu des aperçus web | [Ouvrir un navigateur de session](browser-sidecars.md#session-browser) |
| Pont d’automatisation | Indisponible (`/api/opencode-plugin/`). Les capacités natives de bureau ne deviennent pas des capacités navigateur. |
| Mises à niveau WebSocket | Disponibles pour les aperçus web et, sur les appareils appairés, pour les [conversations vocales en direct](voice.md#conversation). |

Utilisez une connexion en boucle locale sur l’hôte pour les proxys/WebSockets réservés à l’hôte et la gestion du Contrôle à distance (`/api/remote-control/`). L’accès LAN direct exige lui aussi la boucle locale pour ces opérations ; voir [Origines autorisées](remote-access.md#upgrading).

## Relais et confidentialité {#relay-privacy}

CodeNomad utilise [OpenTunnel](https://github.com/anomalyco/opentunnel) et réserve une route aléatoire sur l’identité de tunnel par défaut partagée de la machine.

TLS se termine dans le backend CodeNomad. Le relais transfère du texte chiffré et ne peut pas lire le contenu applicatif, mais peut observer les noms d’hôte, horaires de connexion et volumes de trafic. Le certificat/la clé privée du tunnel restent sur l’hôte. Protégez le stockage du tunnel et la configuration CodeNomad comme des identifiants ; une adresse impossible à deviner n’est pas une autorisation.

`CODENOMAD_REMOTE_CONTROL_API` sélectionne une API OpenTunnel auto-hébergée ; non définie, elle utilise le service hébergé. Cela change le déploiement du tunnel, pas les exigences d’appairage ni les surfaces bloquées. Voir [Sécurité](security.md) pour le traitement des identifiants et diagnostics.

## Politique de l’administrateur {#administrator-policy}

Un administrateur peut désactiver le contrôle à distance pour tous les utilisateurs d’un ordinateur : définissez la variable d’environnement `CODENOMAD_REMOTE_CONTROL=disabled` pour tout le système, puis redémarrez CodeNomad. Le backend ne connecte alors jamais de tunnel, refuse **Démarrer le contrôle à distance** et les liens d’appairage et ne se reconnecte pas au lancement ; les réglages affichent **Désactivé par l’administrateur**. Les appareils appairés auparavant ne peuvent pas se connecter et restent listés pour que vous puissiez les révoquer. Non définie ou vide, elle n’impose aucune politique ; toute autre valeur, même composée seulement d’espaces, empêche le backend de démarrer.
