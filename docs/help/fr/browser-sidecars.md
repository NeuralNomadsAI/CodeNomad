# Aperçus navigateur et SideCars

## Ouvrir un navigateur de session {#session-browser}

1. Dans la barre d’outils d’une conversation, choisissez **Ouvrir l'aperçu web**.
2. Saisissez une **URL de l'aperçu** `http://` ou `https://` sans identifiants, puis choisissez **Ouvrir l'aperçu**. Utilisez la barre d’outils pour naviguer, actualiser et aller en arrière/en avant.
3. Utilisez le bouton de fermeture de l’aperçu pour revenir au chat. Rouvrez-le dans cette conversation pour poursuivre.

Les service workers restent désactivés dans les aperçus distants.

Cliquer sur un lien `localhost` ou `127.0.0.1` dans une conversation l'ouvre dans l'aperçu web de cette session, sur tout client où les aperçus sont disponibles. Via Remote Control lorsque l'hôte garde les aperçus web désactivés, ou sur un client où les aperçus sont autrement indisponibles, ces liens conservent leur comportement normal dans le navigateur. Ctrl+clic (⌘-clic sur macOS) ou clic milieu ouvre le lien dans votre navigateur à la place. Dans le cadre d'aperçu sandboxé, où aucun stockage réel n'est disponible, la page reçoit un `localStorage`, un `sessionStorage` et un `document.cookie` en mémoire pour le chargement actuel de la page ; un hôte d'aperçu par jeton ouvert seul conserve son stockage réel.

Chaque aperçu appartient à son dossier de projet et sa session. Changer de conversation, projet, Info ou chat masque un invité natif explicitement ouvert sans abandonner son document/historique actif. Les invités masqués ne sont pas des cibles d’automatisation. Fermer le projet/la fenêtre ou redémarrer le moteur de rendu termine le document actif.

L’historique enregistré se restaure seulement à la réouverture explicite du navigateur de cette session, pas au démarrage/à la sélection de session. Il stocke des URL et un curseur, pas les formulaires non envoyés, le DOM, les corps POST ou la mémoire JavaScript. L’historique est borné à 32 URL par session et à un budget de disposition partagé ; les anciennes entrées peuvent être retirées. Restaurer une URL peut recharger la page ; ce n’est pas un rejeu de transaction.

Dans un onglet de projet distant, l’aperçu passe par le serveur CodeNomad de ce projet. La barre d’adresse et l’historique enregistré affichent l’URL de l’application. Fermer l’aperçu ou l’onglet du projet, déconnecter/supprimer le serveur ou quitter termine la page et ses connexions ; la réouverture recharge l’adresse enregistrée avec son historique. Les identifiants de connexion au serveur restent sur le backend ; les cookies applicatifs relayés sont filtrés. Gardez les adresses internes de chargement des aperçus dans CodeNomad.

Les aperçus distants natifs désactivent les menus contextuels, le glisser de liens, l’impression, les fenêtres surgissantes, les téléchargements, les dialogues de page et les demandes de permission afin de garder les adresses internes privées. Enregistrez le travail de la page avant de fermer.

## Connexions partagées et limites d’automatisation {#signins-automation}

Les aperçus natifs partagent cookies, connexions et stockage de site entre projets/sessions dans le même moteur de bureau et périmètre profil/configuration, séparément du moteur de rendu de confiance CodeNomad. Se déconnecter d’un site dans un aperçu affecte les autres qui utilisent ce stockage. Documents, formulaires, stockage de session, historiques de navigation et rattachements d’automatisation restent propres à la session. Les aperçus iframe ne sont pas un profil de navigateur natif partagé complet.

| Client | Implémentation de l’aperçu | Automatisation navigateur par agent | Modèles mobiles |
| --- | --- | --- | --- |
| Electron sur les plateformes de bureau prises en charge | Invité Chromium natif ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri Windows | Enfant WebView2 natif ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri macOS (14+) | Vue enfant WKWebView native ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Identité mobile WebKit et viewport CSS ; limites de saisie natives |
| Tauri Linux | Vue enfant WebKitGTK native ; pop-ups OAuth, téléchargements et dialogues | Prise en charge pour l’aperçu de session détenu visible | Identité mobile WebKit et viewport CSS ; limites natives de densité/saisie |
| Navigateur ordinaire/vue distante | Iframe de repli | Aucune cible locale d’aperçu natif | Dimensions seules |

Sur tous les hôtes de bureau natifs, l’outil `codenomad.browser` lié à la session ouvre, navigue et capture l’aperçu et effectue les actions clic, saisie, sélection, survol, glisser, défilement, touches et attente de texte. L’exécution vérifie le backend propriétaire, les capacités natives, la session et la cible visible. Les cibles masquées, remplacées ou ayant navigué sont refusées ; les actions ne sont jamais répétées automatiquement. Le contenu reste non fiable. Pour les sites bloquant l’iframe, utilisez un navigateur externe.

Les aperçus natifs s’ouvrent manuellement ou par l’agent, conservent les connexions partagées entre redémarrages et utilisent l’historique natif arrière/avant. Les menus et dialogues locaux masquent l’aperçu. Les commentaires sur éléments sont indisponibles en mode natif. Les captures WebKit parcourent les shadow roots fermés créés par script ; les racines fermées déclaratives restent opaques. Sur macOS, le premier survol peut omettre pointerenter et ⌘A sélectionne par le responder natif sans keydown A. Sous GTK, la lecture du presse-papiers passe par Ctrl+V explicite ; écriture et copier/coller natifs fonctionnent.

Les pop-ups natifs partagent les connexions de l’aperçu, conservent `opener`/`postMessage` et se ferment avec leur page d’origine. Les adresses saisies/restaurées acceptent HTTP(S) sans identifiants ; les sites peuvent aussi ouvrir des documents vierges et blob de même origine. Les schémas de fichiers et applicatifs sont bloqués. Les téléchargements vont dans Téléchargements, avec des noms assainis et uniques, sans écrasement ni ouverture automatique. Caméra, microphone, localisation et notifications sont refusés ; les permissions classifiées demandent un consentement, les requêtes inconnues affichent une erreur. Tauri et Electron prennent en charge `alert`/`confirm`/`prompt` ; le dialogue prompt d’Electron couvre les pages principales de l’aperçu, les pop-ups et les sous-frames. Les sélecteurs de périphériques et d’écrans permettent de faire défiler les entrées disponibles. Les autres API dépendent du moteur et du matériel.

Les sites peuvent demander confirmation à la fermeture d’un pop-up natif. Sous Linux, le consentement au verrouillage du pointeur apparaît en haut de sa fenêtre. Les versions de WebKitGTK affectées par [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277), dont 2.52.6, nécessitent le sélecteur de fichiers de la page pour les envois : l’accès aux fichiers déposés est bloqué pour des raisons de sécurité. Enregistrez le travail de la page avant de fermer ou recharger la fenêtre CodeNomad qui l’héberge.

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

Sur Electron et Tauri Windows, les modèles mobiles définissent identité Android/Chromium, orientation, tactile et DPR 2.75 sur l’invité détenu seulement. Revenir à adaptatif/bureau/tablette efface ces remplacements et recharge. Tauri macOS/Linux appliquent une identité mobile WebKit générique en HTTP et JavaScript et ajustent les viewports CSS indépendamment du zoom/DPI de l’application, avec rechargement au changement ou à la réinitialisation. macOS utilise un DPR natif de 2,75 si disponible ; la densité GTK suit le zoom d’ajustement et le moniteur. Écran, plateforme, médias pointeur/survol et nombre maximal de contacts conservent leurs valeurs natives de bureau. Les clics mobiles GTK produisent du tactile natif avec événements souris de compatibilité ; macOS conserve la souris. L’iframe de repli redimensionne seulement. Ces profils servent de références de disposition ; claviers téléphoniques, barres système et réglages de texte mobile restent hors périmètre. Enregistrez le travail de page avant de changer de modèle, car le rechargement peut perdre l’état non envoyé.

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

L’enregistrement est une configuration serveur partagée par ses clients ; il n’installe ni ne démarre le service. Le port est sur l’hôte du backend, pas votre portable ou téléphone. **En cours d'exécution** indique l’accessibilité, pas le bon état de l’application/authentification de l’outil. Retirer l’enregistrement n’arrête pas le processus lancé séparément. Fermer son onglet ne l’arrête pas non plus.

Si le service est inaccessible, vérifiez le processus et le port sur le backend. Si HTML charge mais pas les ressources/WebSockets, vérifiez le chemin de base et le mode de préfixe. Recréez un enregistrement erroné avec les paramètres voulus ; n’exposez pas l’amont publiquement pour contourner une erreur de proxy. Les applications SideCar peuvent exposer un terminal ou des fichiers avec l’autorité du compte serveur ; faites confiance à leurs utilisateurs et configuration.

Un SideCar est une extension de confiance de CodeNomad, pas un aperçu en bac à sable : sa page s’exécute avec l’origine même de CodeNomad, si bien que ses scripts peuvent utiliser CodeNomad avec votre accès connecté. N’enregistrez que des services dont vous jugez le code fiable. CodeNomad ne transmet pas ses propres cookies de connexion au service, tandis que les cookies propres au service sont conservés.

Le contenu SideCar (`/sidecars/`) et les WebSockets SideCar exigent une connexion en boucle locale sur l’hôte. L’enregistrement via `/api/sidecars` est accessible aux appareils appairés et aux clients LAN directs authentifiés. Le contenu des aperçus actifs (`/previews/`) est accessible directement depuis le LAN avec un jeton de capacité valide ; les aperçus web du [Contrôle à distance](remote-control.md#remote-surface) restent accessibles avec leur jeton de capacité lorsqu’ils sont activés. Voir [Mise à niveau](remote-access.md#upgrading) pour les conditions de l’accès direct.

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
