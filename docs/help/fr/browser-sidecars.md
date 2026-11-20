# Aperçus navigateur et SideCars

Les aperçus iframe et les SideCars refusent les connexions aux adresses et ports d'écoute de CodeNomad, y compris via des alias DNS. Utilisez le port distinct du serveur de votre application.

## Ouvrir un navigateur de session {#session-browser}

1. Dans la barre d’outils d’une conversation, choisissez **Ouvrir l'aperçu web**.
2. Saisissez une **URL de l'aperçu** `http://` ou `https://` sans identifiants, puis choisissez **Ouvrir l'aperçu**. Utilisez la barre d’outils pour naviguer, actualiser et aller en arrière/en avant.
3. Utilisez le bouton de fermeture de l’aperçu pour revenir au chat. Rouvrez-le dans le même onglet et la même conversation pour poursuivre.

Les service workers restent désactivés dans les aperçus distants.

Cliquer sur un lien `localhost` ou `127.0.0.1` dans une conversation l'ouvre dans l'aperçu web de cette session, sur tout client où les aperçus sont disponibles. Via Remote Control lorsque l'hôte garde les aperçus web désactivés, ou sur un client où les aperçus sont autrement indisponibles, ces liens conservent leur comportement normal dans le navigateur. Ctrl+clic (⌘-clic sur macOS) ou clic milieu ouvre le lien dans votre navigateur à la place.

Chaque session possède un aperçu dans la fenêtre. Les onglets dupliqués choisissent indépendamment entre le chat et ce même aperçu actif, partageant page, URL, historique et modèle de viewport. Le bouton de fermeture ramène seulement son onglet au chat. Changer d’onglet, de conversation, de projet ou d’Info conserve le document ; fermer un doublon le conserve tant qu’une autre occurrence de la session reste ouverte. Fermer la dernière occurrence ou la fenêtre, ou redémarrer le moteur de rendu, termine le document actif.

Chaque onglet enregistre son choix chat/aperçu ; la session enregistre l’URL, le modèle de viewport et l’historique partagés. Les pages enregistrées se chargent seulement à la réouverture explicite du navigateur de session. La persistance conserve les URL et un curseur ; formulaires actifs, DOM, corps POST et mémoire JavaScript disparaissent avec le document. L’historique est limité à 32 URL par session et à un budget partagé par fenêtre ; les anciennes entrées peuvent être retirées. Restaurer une URL peut recharger la page.

Dans un onglet de projet distant, l’aperçu passe par le serveur CodeNomad de ce projet. La barre d’adresse et l’historique enregistré affichent l’URL de l’application. Fermer l’aperçu ou l’onglet du projet, déconnecter/supprimer le serveur ou quitter termine la page et ses connexions ; la réouverture recharge l’adresse enregistrée avec son historique. Les identifiants de connexion au serveur restent sur le backend ; les cookies applicatifs relayés sont filtrés. Gardez les adresses internes de chargement des aperçus dans CodeNomad. Sur un client distant authentifié, l’aperçu se charge via l’adresse de cet hôte ; les appareils appairés suivent l’interrupteur **Aperçus web** de l’hôte, et la déconnexion ou la révocation de l’appareil y met fin.

Les commandes d’aperçu s’affichent lorsque l’hôte et le serveur du projet distant confirment que les aperçus sont disponibles.

Les aperçus distants natifs désactivent les menus contextuels, l’export vers le presse-papiers, le glisser de liens, l’impression, les fenêtres surgissantes, les téléchargements, les dialogues de page et les demandes de permission afin de garder les adresses internes privées. Enregistrez le travail de la page avant de fermer.

## Connexions partagées et limites d’automatisation {#signins-automation}

Les aperçus natifs partagent cookies, connexions et stockage de site entre projets/sessions dans le même moteur de bureau et périmètre profil/configuration, séparément du moteur de rendu de confiance CodeNomad. Se déconnecter d’un site dans un aperçu affecte les autres qui utilisent ce stockage. Documents, formulaires, stockage de session, historiques de navigation et rattachements d’automatisation appartiennent à chaque session.

Un agent ouvre le navigateur partagé de la session dans un onglet qui la contient, de préférence l’onglet actif. L’onglet choisi reste fixé pendant l’ouverture ; sa fermeture annule cette ouverture. Les actions sur la page ciblent l’aperçu natif visible de la session ; les aperçus masqués sont exclus.

| Client | Implémentation de l’aperçu | Automatisation navigateur par agent | Modèles mobiles |
| --- | --- | --- | --- |
| Electron sur les plateformes de bureau prises en charge | Invité Chromium natif ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri Windows | Enfant WebView2 natif ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri macOS (14+) | Vue enfant WKWebView native ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Identité mobile WebKit et viewport CSS ; limites de saisie natives |
| Tauri Linux | Vue enfant WebKitGTK native ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Identité mobile WebKit et viewport CSS ; limites natives de densité/saisie |
| Navigateur ordinaire/vue distante | Iframe de repli | Aucune cible locale d’aperçu natif | Dimensions seules |

Les commentaires sur éléments sont indisponibles en mode natif. Sous GTK, la lecture du presse-papiers passe par Ctrl+V explicite ; écriture et copier/coller natifs fonctionnent. Pour les sites bloquant l’iframe, utilisez un navigateur externe.

Les pop-ups natifs partagent les connexions de l’aperçu, conservent `opener`/`postMessage` et se ferment avec leur page d’origine. Les adresses saisies/restaurées acceptent HTTP(S) sans identifiants ; les sites peuvent aussi ouvrir des documents vierges et blob de même origine. Les schémas de fichiers et applicatifs sont bloqués. Les téléchargements vont dans Téléchargements, avec des noms assainis et uniques, sans écrasement ni ouverture automatique. Caméra, microphone, localisation et notifications sont refusés ; les permissions classifiées demandent un consentement, les requêtes inconnues affichent une erreur. Tauri et Electron prennent en charge `alert`/`confirm`/`prompt` ; le dialogue prompt d’Electron couvre les pages principales de l’aperçu, les pop-ups et les sous-frames.

Les sites peuvent demander confirmation à la fermeture d’un pop-up natif. Les versions de WebKitGTK affectées par [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), dont 2.52.6, nécessitent le sélecteur de fichiers de la page pour les envois : l’accès aux fichiers déposés est bloqué pour des raisons de sécurité. Enregistrez le travail de la page avant de fermer ou recharger la fenêtre CodeNomad qui l’héberge.

Sur Tauri macOS/Linux, donnez le focus à l’aperçu pour le zoomer avec ⌘/Ctrl +, − ou 0, ou avec le menu de zoom de l’application. Si le focus est ailleurs, ces commandes de menu zooment l’application.

## Choisir parmi six modèles de zone d’affichage {#templates}

1. Ouvrez le menu de zone d’affichage de l’aperçu.
2. Sélectionnez un modèle ci-dessous. Utilisez directement les entrées portrait/paysage ; aucune commande de rotation séparée.
3. Sur Electron et Tauri Windows, attendez-vous à un rechargement natif en entrant/changeant l’émulation mobile ou en revenant à un modèle de dimensions seules.

| Modèle | Zone d’affichage CSS |
| --- | --- |
| Zone adaptative | Espace d’aperçu disponible |
| Zone de bureau | 1440 × 900 |
| Zone de tablette | 768 × 1024 |
| Tablette paysage | 1024 × 768 |
| Zone mobile | 390 × 844 |
| Mobile paysage | 844 × 390 |

Sur Electron et Tauri Windows, les modèles mobiles définissent identité Android/Chromium, orientation, tactile et DPR 2.75 sur l’invité détenu seulement. Revenir à adaptatif/bureau/tablette efface ces remplacements et recharge. Tauri macOS/Linux appliquent une identité mobile WebKit générique en HTTP et JavaScript et ajustent les viewports CSS indépendamment du zoom/DPI de l’application, avec rechargement au changement ou à la réinitialisation. macOS utilise un DPR natif de 2,75 si disponible ; la densité GTK suit le zoom d’ajustement et le moniteur. L’iframe de repli redimensionne seulement. Ces profils servent de références de disposition ; claviers téléphoniques, barres système et réglages de texte mobile restent hors périmètre. Enregistrez le travail de page avant de changer de modèle, car le rechargement peut perdre l’état non envoyé.

## Enregistrer un SideCar {#register-sidecar}

1. Démarrez l’outil web séparément sur l’hôte backend CodeNomad, en écoute sur `127.0.0.1:<port>`.
2. Ouvrez **Paramètres → SideCars**. Saisissez **Nom** et **Port** ; vérifiez le **Chemin de base** dérivé (`/sidecars/<id>`).
3. Réglez **Protocole** selon le service amont et choisissez **Mode de préfixe**.
4. Choisissez **Ajouter un SideCar**, puis **Ouvrir SideCar** depuis l’accueil pour ouvrir son onglet.

| Choix | Effet exact |
| --- | --- |
| HTTPS (défaut du formulaire) | CodeNomad se connecte à l’amont via `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad se connecte à l’amont via `http://127.0.0.1:<port>`. Cela ne change pas le TLS de la connexion publique CodeNomad. |
| Retirer le préfixe (défaut) | `/sidecars/<id>/path` est transmis à l’amont comme `/path`. |
| Conserver le préfixe | `/sidecars/<id>/path` est transmis à l’amont inchangé. Configurez le chemin de base du service pour correspondre. |

L’enregistrement est une configuration serveur partagée par ses clients ; il n’installe ni ne démarre le service. Le port est sur l’hôte du backend, pas votre portable ou téléphone. Retirer l’enregistrement n’arrête pas le processus lancé séparément. Fermer son onglet ne l’arrête pas non plus.

Si le service est inaccessible, vérifiez le processus et le port sur le backend. Si HTML charge mais pas les ressources/WebSockets, vérifiez le chemin de base et le mode de préfixe. Recréez un enregistrement erroné avec les paramètres voulus ; n’exposez pas l’amont publiquement pour contourner une erreur de proxy. Les applications SideCar peuvent exposer un terminal ou des fichiers avec l’autorité du compte serveur ; faites confiance à leurs utilisateurs et configuration.

Un SideCar est une extension de confiance de CodeNomad, pas un aperçu en bac à sable : sa page s’exécute avec l’origine même de CodeNomad, si bien que ses scripts peuvent utiliser CodeNomad avec votre accès connecté. N’enregistrez que des services dont vous jugez le code fiable. CodeNomad ne transmet pas ses propres cookies de connexion au service, tandis que les cookies propres au service sont conservés.

Le contenu SideCar (`/sidecars/`) et les WebSockets SideCar exigent une connexion en boucle locale sur l’hôte. Pour les ouvrir aussi depuis d’autres appareils, activez **Ouvrir les SideCars en HTTPS** dans **Paramètres → SideCars** sur l’hôte : les navigateurs connectés via les adresses HTTPS de ce serveur ou une origine HTTPS de `CODENOMAD_ALLOWED_ORIGINS`, comme un proxy inverse TLS, peuvent alors ouvrir les SideCars. HTTP simple, les adresses `localhost` et le Contrôle à distance restent réservés à l’hôte. L’enregistrement via `/api/sidecars` est accessible aux appareils appairés et aux clients LAN directs authentifiés. Le contenu des aperçus actifs (`/previews/`) est accessible directement depuis le LAN avec un jeton de capacité valide ; les aperçus web du [Contrôle à distance](remote-control.md#remote-surface) restent accessibles avec leur jeton de capacité lorsqu’ils sont activés. Voir [Mise à niveau](remote-access.md#upgrading) pour les conditions de l’accès direct.

## Recette OpenVSCode Server {#openvscode}

1. Sur l’hôte backend, lancez Docker avec le service lié à la boucle locale :

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Enregistrez **Nom** `VSCode`, **Port** `8000`, **Protocole** `HTTP`, **Mode de préfixe** **Conserver le préfixe**.
3. Vérifiez que le chemin de base affiché est `/sidecars/vscode`, puis ouvrez le SideCar.

Cette recette shell monte votre dossier personnel dans le conteneur ; utilisez un montage plus restreint si l’éditeur ne doit accéder qu’à cela. Le `--server-base-path` du service doit correspondre exactement à l’enregistrement. Arrêtez le conteneur séparément une fois terminé ; supprimer le SideCar ne le retire pas, ni ses fichiers.

## Recette de terminal ttyd {#ttyd}

1. Sur l’hôte backend, démarrez un terminal shell modifiable lié à la boucle locale :

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Enregistrez **Nom** `Terminal`, **Port** `7681`, **Protocole** `HTTP`, **Mode de préfixe** **Retirer le préfixe**.
3. Ouvrez le SideCar au chemin de base `/sidecars/terminal` affiché.

Le terminal utilise les privilèges du compte qui a démarré ttyd. Choisissez un autre shell si `zsh` est indisponible. Utilisez le port réel si vous avez changé celui par défaut de ttyd, et arrêtez ttyd séparément une fois terminé. Authentifiez et protégez l’accès à CodeNomad ; un terminal modifiable n’est pas un bac à sable.
