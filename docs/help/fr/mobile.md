# Mobile et PWA

Utilisez l’interface navigateur sur téléphone ou tablette pour poursuivre le travail sur l’hôte du backend. Installer la PWA change la manière d’ouvrir l’interface, pas le lieu des projets, identifiants ou de l’exécution des agents.

## Se connecter depuis un téléphone ou une tablette {#connect}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant → Contrôle à distance**, puis choisissez **Démarrer le contrôle à distance**.
2. Scannez le QR code d’appairage avec votre appareil mobile et ouvrez le lien dans le navigateur que vous comptez garder.
3. Sinon, configurez l’[accès direct](remote-access.md), ouvrez l’URL HTTPS accessible et de confiance de l’hôte, puis connectez-vous avec son mot de passe serveur.

Le Contrôle à distance exige un appairage ; les connexions directes nécessitent routage, écoute accessible et authentification. N’utilisez pas `localhost` sur le téléphone pour atteindre votre poste. Perdre les données de site ou changer de profil navigateur peut nécessiter une nouvelle connexion ou un appairage ; voir [Contrôle à distance](remote-control.md).

## Installer la PWA {#install-pwa}

1. Ouvrez l’URL CodeNomad fonctionnelle en HTTPS de confiance dans un navigateur acceptant l’installation.
2. Dans Chrome/Edge et les navigateurs similaires, utilisez l’action d’installation de la barre d’adresse ou l’action **Install CodeNomad** du navigateur si proposée. Sur Safari iPhone/iPad, utilisez **Share → Add to Home Screen** ; le libellé exact dépend du système/navigateur.
3. Ouvrez le nouveau lanceur et effectuez la connexion ou l’appairage si son stockage navigateur est séparé.

L’installation est propre à chaque appareil/navigateur et origine. Elle n’installe pas Node, Git ou OpenCode sur le téléphone, ne démarre pas de backend et n’accorde pas d’intégrations natives de bureau. Supprimer le lanceur ne supprime pas les conversations de l’hôte ; révoquez séparément un appareil appairé pour retirer l’accès.

### Contexte sécurisé et certificats {#secure-context}

L’installation PWA distante et l’accès microphone nécessitent un contexte sécurisé reconnu par le navigateur. Utilisez un certificat HTTPS de confiance correspondant exactement au nom d’hôte/à l’IP. Un certificat local généré doit être explicitement approuvé par l’appareil/navigateur client ; une page d’avertissement ou son contournement n’est pas une configuration d’installation fiable. Les exceptions localhost des navigateurs s’appliquent à cet appareil, pas à une adresse HTTP LAN d’un autre hôte.

Si l’installation manque, confirmez d’abord la confiance HTTPS et la prise en charge du navigateur, puis rouvrez la page dans le navigateur complet plutôt qu’un navigateur QR/intégré. Pour les échecs de microphone, vérifiez les permissions de site navigateur/système et [Voix](voice.md). Ne désactivez pas l’authentification ou la vérification TLS pour réparer l’installation.

## Travailler avec les dispositions tactiles {#touch-layout}

Utilisez les commandes **Volet gauche** et **Volet droit** pour ouvrir navigation et outils. Sur les dispositions étroites, les panneaux recouvrent la conversation au lieu d’imposer une largeur de bureau ; ouvrir un panneau flottant ferme l’autre. Les actions d’en-tête passent dans leur menu de débordement si l’espace manque.

La zone de saisie garde Agent, Modèle et Réflexion dans son pied. Le champ se redimensionne avec la conversation visible, y compris le clavier à l’écran ; les longs brouillons restent défilables. Sur les appareils uniquement tactiles, l’envoi ne rouvre pas le clavier à l’écran, pour que vous puissiez lire la réponse ; touchez la zone de saisie pour continuer. Pendant qu’une session travaille, le menu **Plus d'actions** de la zone de saisie propose **Mettre le message en file d'attente** ou **Injecter maintenant**, selon ce que votre envoi normal ne fait pas, sans nécessiter de raccourci de clavier physique. Ouvrir une interruption compacte temporairement la zone de saisie sans changer sa hauteur enregistrée ni son brouillon. Répondez aux autorisations/questions dans le dock au-dessus, en gardant son pied d’actions accessible. Voir [Conversations](conversations.md) et [Autorisations](permissions.md).

## Limites de capacité et connectivité {#limits}

| Fonctionnalité | Navigateur mobile / PWA |
| --- | --- |
| Projets, conversations, fichiers et autorisations | Opèrent sur l’hôte backend connecté, sous ses contrôles d’accès. Les pièces jointes d’appareil sont transférées depuis le téléphone ; les références de projet sont résolues sur l’hôte. |
| Fenêtres natives de bureau, menus système et automatisation native de l’hôte | Non fournis par l’installation de la PWA. |
| Aperçu navigateur | N’acquiert pas de capacités natives de navigateur invité ; le rendu de repli reste limité par le navigateur. |
| Contenu SideCar et WebSockets | Dépendent du chemin de connexion ; le Contrôle à distance bloque le proxy de contenu SideCar, le contenu d’aperçu et les mises à niveau WebSocket. Voir ses [restrictions exactes](remote-control.md). |
| Microphone, presse-papiers, notifications et proposition d’installation | Dépendent de la prise en charge navigateur/système, du contexte sécurisé et des permissions utilisateur. |
| Travail hors ligne | Aucun backend hors ligne ni historique API en cache. Les ressources d’interface statiques peuvent être en cache, mais les documents et réponses API ne constituent pas un espace de travail hors ligne. |

Gardez le backend accessible. La suspension par le système mobile ou un changement de réseau peut déconnecter le flux d’événements ; au retour, le client reconnecte et relit l’état actuel, sans rejeu d’événements garanti. Vérifiez si une action s’est terminée avant de réessayer. Fermer la PWA n’arrête pas un backend autonome ; quitter l’application de bureau hôte et son backend rend le Contrôle à distance indisponible jusqu’au prochain lancement.
