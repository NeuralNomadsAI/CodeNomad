# Dictée, lecture et conversation vocale

## Configurer la voix {#configure}

Ouvrez **Préférences → Voix** (**Paramètres → Voix** dans un navigateur ou une fenêtre distante). Les cartes **Dictée**, **Lecture** et **Conversation** affichent chacune leur état.

1. Dans **Dictée**, choisissez le [moteur de l’appareil](#desktop-dictation) dans les préférences locales. Le navigateur et le mobile utilisent uniquement l’API.
2. Pour la dictée par API et la lecture, ouvrez **Identifiants API** depuis l’une des deux cartes. Renseignez **Clé API** et, si besoin, **URL de base**, **Modèle de transcription** et **Modèle vocal**. Pour utiliser deux services, activez **Fournisseurs séparés pour l'entrée et la sortie**, remplissez leurs champs et cliquez sur **Enregistrer**.
3. **Lecture** indique le **Fournisseur**. Réglez **Voix par défaut**, **Mode de lecture** et **Format de sortie**, puis cliquez sur **Enregistrer**.

Les paramètres et clés vocaux appartiennent à la configuration du serveur CodeNomad connecté, pas au projet sélectionné ni à la connexion fournisseur OpenCode. Les autres clients qui la partagent les utilisent. Les clés enregistrées sont masquées : un champ vide conserve la valeur ; **Effacer la clé enregistrée** prévoit sa suppression à l’enregistrement. Une direction sans point d’accès ni clé propres peut utiliser les paramètres partagés ; un point d’accès séparé nécessite sa clé et une clé séparée nécessite son point d’accès. Lors d’un changement de point d’accès, fournissez explicitement la clé voulue et vérifiez la configuration enregistrée ; ce changement efface la clé enregistrée de cet emplacement plutôt que de l’envoyer à un autre hôte.

Le backend peut aussi utiliser `OPENAI_API_KEY` et `OPENAI_BASE_URL` comme valeurs partagées par défaut. Effacer une clé enregistrée ne retire pas un identifiant fourni par l’environnement ; changez cet environnement côté backend et redémarrez-le pour supprimer ce repli.

| Réglage | Sens / valeur par défaut |
| --- | --- |
| URL de base | Racine API compatible OpenAI, par défaut `https://api.openai.com/v1`. L’entrée utilise `audio/transcriptions` ; la sortie utilise `audio/speech`. |
| Modèle de transcription / Modèle d’entrée | Modèle accepté par le point d’accès STT ; par défaut `gpt-4o-mini-transcribe`. |
| Modèle vocal / Modèle de sortie | Modèle accepté par le point d’accès TTS ; par défaut `gpt-4o-mini-tts`. |
| Voix par défaut | Identifiant de voix fournisseur ; par défaut `alloy`. Ce n’est pas un sélecteur de voix système. |
| Flux continu | Valeur par défaut. Commence la lecture à l’arrivée de l’audio, si le fournisseur et le navigateur prennent en charge le format sélectionné. |
| Mis en mémoire tampon | Attend la réponse audio complète avant lecture. |
| Format de sortie | `mp3`, `wav`, `opus` ou `aac` ; par défaut `mp3`. La compatibilité varie selon le navigateur/fournisseur. |

Ce sont des demandes au service configuré, pas une garantie que chaque point d’accès compatible implémente chaque modèle, voix ou format.

## Tester l’entrée et la sortie {#test}

1. Enregistrez d’abord les changements de point d’accès, clé, modèle et voix.
2. Choisissez **Tester l'entrée API**, accordez l’accès au microphone, parlez, puis **Arrêter l'enregistrement**. Vérifiez la transcription reçue.
3. Choisissez **Tester la lecture** pour entendre l’extrait ; **Arrêter l'extrait** l’arrête.

Le test de lecture utilise immédiatement le mode et le format sélectionnés, mais le point d’accès, la clé, le modèle et la voix viennent des paramètres enregistrés. **Tester l'entrée API** envoie l’audio au fournisseur API configuré, quel que soit le moteur de dictée. Aucun prompt de conversation n’est envoyé. Le fournisseur peut facturer ces tests.

## Dicter un prompt {#dictate}

1. Gardez **Saisie vocale du prompt** activée dans **Voix** (elle l’est par défaut).
2. Dans **Plus d'actions**, cochez **Mode dictée**. Décochez le mode actif avant de choisir l’autre.
3. Maintenez le bouton micro à côté de **Plus d'actions** (ou la barre d’espace quand le bouton a le focus), parlez, puis relâchez pour transcrire. Autorisez le microphone si nécessaire. Changer de conversation ou fermer la zone de saisie annule la dictée.
4. Relisez le texte. Il remplace la sélection d’origine si le brouillon et la sélection n’ont pas changé ; sinon, choisissez **Insérer la transcription** en mode normal ou **Ignorer la transcription** avant de dicter de nouveau. La dictée n’envoie jamais le brouillon.

Si l’API utilise le mode WAV de secours sur Tauri sous Linux, la dictée et **Tester l'entrée API** arrêtent l’enregistrement au bout de 24 secondes. L’extrait reste sur cet appareil jusqu’à ce que vous choisissiez **Transcrire** pour l’envoyer au fournisseur vocal ou **Annuler** pour le supprimer.

Les enregistrements compressés pour l’API s’arrêtent à la taille maximale et proposent les mêmes choix : **Transcrire** ou **Annuler**.

### Choisir un moteur sur ordinateur {#desktop-dictation}

Dans **Préférences → Voix → Dictée** sur le bureau local, sélectionnez **Moteur de dictée sur cet appareil**. Ce choix vaut pour tous les projets sur cet appareil. **Fournisseur API** utilise les réglages du serveur connecté et nécessite un contexte sécurisé pour le microphone.

- Si le moteur enregistré est indisponible, choisissez ici **Hex (local)** s’il est proposé, ou **Fournisseur API**. Sur un Mac Intel ou sous macOS antérieur à la version 15, utilisez **Fournisseur API**.
- Voix indique ce qui manque à Hex, le volume à télécharger pour chaque composant et le total. Un clic sur **Activer Hex** vérifie et réutilise les fichiers compatibles, télécharge ce qui manque, puis sélectionne Hex dès qu’il est prêt. Suivez la progression dans Voix ; utilisez **Annuler l’activation de Hex** pour arrêter et **Reprendre l’activation de Hex** lorsque l’action est proposée. En cas d’échec ou d’annulation, le moteur précédent reste sélectionné. Rouvrir les préférences, sélectionner **Hex (local)** déjà prêt ou dicter avec ne déclenche aucun téléchargement.
- Hex est proposé sur les configurations compatibles : Windows x64/arm64, Mac Apple Silicon sous macOS 15 ou plus récent, Linux x64/arm64 avec glibc 2.36 ou plus récente et les bibliothèques requises par Hex. Les Mac Intel et les systèmes Linux avec une glibc plus ancienne ou musl sont incompatibles. Le moteur et les modèles sont séparés de l’installateur CodeNomad ; aucun terminal ni clé API n’est nécessaire.

Ubuntu 24.04 satisfait au prérequis glibc, contrairement à Ubuntu 22.04. Hex détecte la langue parlée parmi les [langues du modèle Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), dont le français et l’anglais. Cette liste est indépendante de la langue de l’application.

Hex charge son modèle en arrière-plan dès le début de l’enregistrement et le garde prêt pendant trois minutes après la dernière dictée.

La reconnaissance locale fonctionne hors ligne, y compris pour les projets WSL ouverts dans l’application locale. Dans une fenêtre distante compatible, cliquez sur le micro pour ouvrir **Dicter sur cet appareil**. Vérifiez la destination, puis utilisez les commandes d’enregistrement et d’insertion de cette fenêtre. Seul le texte revient dans le brouillon ; le projet distant doit rester connecté à son serveur.

Dans une fenêtre Tauri distante sous Linux, **Tester l'entrée API** vérifie l’API vocale du serveur sans changer le moteur de dictée. Vérifiez l’adresse du serveur dans la boîte de dialogue native du microphone avant de confirmer chaque enregistrement pour l’API. La capture utilise PulseAudio ou le service PulseAudio de PipeWire et applique toujours la limite WAV de 24 secondes décrite ci-dessus.

Gemini Live et OpenAI Realtime sont indisponibles dans les fenêtres Tauri distantes sous Linux : ces fenêtres utilisent l’enregistreur natif pour la dictée et les tests d’entrée, et WebKit bloque l’accès direct au microphone.

## Lire les messages à voix haute {#playback}

1. Utilisez **Lire le message** sur un message, ou la même action sur un appel d’outil, lorsque TTS est disponible.
2. Utilisez **Arrêter la lecture** sur la même commande pour l’arrêter ; démarrer une autre lecture arrête celle en cours.
3. Changez la voix, le mode ou le format dans **Lecture**, ou le modèle dans **Identifiants API**, puis enregistrez.

La lecture utilise la projection textuelle CodeNomad, pas une capture d’écran racontée : les octets binaires/d’images et les reçus d’autorisation ne sont pas du contenu vocal. Elle n’exécute pas de prompt et ne change pas le modèle OpenCode sélectionné.

## Conversation vocale {#conversation}

Gemini Live et OpenAI Realtime sont réservés aux sessions du serveur qui a ouvert cette fenêtre.

Dans **Conversation**, choisissez un **Moteur de conversation** :

- **Classique** nécessite seulement une lecture configurée dans un format compatible. Dans **Plus d'actions**, cochez **Mode conversation**. CodeNomad lit le résumé `spoken` terminé de chaque réponse dans la session principale active. Le mode s’applique à l’onglet du projet jusqu’à ce que vous le décochiez ou rechargiez la page.
- **Gemini Live** et **OpenAI Realtime** ont chacun leur **Clé API**, leur **Modèle** et une **Voix** facultative. Enregistrez les réglages du fournisseur choisi. Ouvrez la session cible, choisissez **Mode conversation** dans **Plus d'actions**, puis **Accepter et démarrer** quand la boîte de dialogue du fournisseur s’affiche. Autorisez le microphone.

Si le fournisseur devient indisponible pendant que la boîte de dialogue est ouverte, choisissez **Réglages vocaux** pour ouvrir la carte **Conversation**.

Le modèle vocal peut lire l’état de la session fixée au démarrage, la dernière réponse visible et les erreurs récentes. Il n’a pas accès aux fichiers. Quand vous lui demandez de transmettre une demande à l’agent, il l’envoie directement comme un message de votre part, sans confirmation à l’écran. Le [mode de permissions de la conversation](permissions.md#conversation-mode) et les questions de l’agent s’appliquent toujours.

Le serveur autorise une seule conversation en direct à la fois par utilisateur connecté, ou par appareil appairé avec le Contrôle à distance. **Arrêter** coupe l’audio en laissant la transcription ouverte. Celle-ci reste en mémoire jusqu’à la fermeture de la fenêtre ; les demandes envoyées à l’agent restent dans la session. La conversation s’arrête aussi après deux minutes sans parole, au bout de huit minutes au total, si la session cible change, si vous fermez la fenêtre ou si la connexion est perdue. Il n’y a ni reconnexion automatique ni bascule vers un autre fournisseur.

Avec OpenAI Realtime, **Interrompre la réponse** coupe la lecture et demande l’annulation de la réponse en cours. Avec Gemini Live, **Arrêter la lecture** coupe seulement le son sur cet appareil : Gemini peut poursuivre sa réponse et envoyer des demandes à l’agent.

## Flux de données et confidentialité {#privacy}

La dictée locale garde l’audio sur l’appareil et ne bascule jamais vers l’API. Avec **Fournisseur API**, l’audio du microphone passe par le serveur CodeNomad jusqu’au point d’accès de transcription configuré. Le texte sélectionné pour synthèse passe par ce backend vers le point d’accès TTS configuré ; l’audio reçu est lu sur le client. Les clés API restent côté serveur et ne sont pas renvoyées comme valeurs enregistrées au formulaire.

Avec **Gemini Live** ou **OpenAI Realtime**, Google ou OpenAI reçoit l’audio du microphone, le nom du projet, la branche, l’arbre de travail, ainsi que le titre et l’état de la session. Le fournisseur peut aussi recevoir le texte de la dernière réponse visible de l’agent et les erreurs récentes. L’utilisation peut être facturée sur votre compte auprès du fournisseur choisi.

Utilisez un fournisseur de confiance pour ce que vous dictez, lisez ou partagez. Les identifiants OpenCode n’autorisent pas automatiquement les services vocaux. Voir [Sécurité](security.md) avant d’exposer un serveur à d’autres utilisateurs.
