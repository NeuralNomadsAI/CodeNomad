# Saisie et lecture vocales

## Configurer l’API vocale {#configure}

1. Ouvrez **Paramètres → Voix**. La carte **Voix** utilise un adaptateur côté serveur compatible OpenAI, indépendamment du fournisseur de modèles de la conversation.
2. Saisissez **Clé API**, et éventuellement **URL de base**, **Modèle de transcription**, **Modèle vocal** et **Voix par défaut**.
3. Si l’entrée et la sortie nécessitent des services différents, activez **Fournisseurs séparés pour l'entrée et la sortie**, puis remplissez les clés, URL de base et modèles d’entrée/sortie.
4. Choisissez **Mode de lecture** et **Format de sortie**, puis **Enregistrer** (disponible tant que des changements ne sont pas enregistrés). Vérifiez l’état affiché à côté des boutons de test, **Configuré**, **Partiellement configuré** ou **Clé API manquante**, avant les tests ; un enregistrement échoué affiche **Échec de l'enregistrement**.

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
2. Choisissez **Tester l'entrée**, accordez l’accès au microphone, parlez, puis **Arrêter l'enregistrement**. Vérifiez la transcription reçue.
3. Choisissez **Tester la lecture** pour entendre l’extrait ; **Arrêter l'extrait** l’arrête.

Le test de lecture utilise immédiatement le mode/format sélectionné, mais le point d’accès, la clé, le modèle et la voix viennent des paramètres enregistrés. Tester l’entrée n’envoie pas de prompt de conversation. Les tests envoient malgré tout de l’audio/du texte au fournisseur vocal configuré et peuvent être facturés.

## Dicter un prompt {#dictate}

1. Gardez **Saisie vocale du prompt** activée dans **Voix** (elle l’est par défaut).
2. Dans **Plus d'actions** de la zone de saisie, choisissez **Dicter** et autorisez le microphone. Si vous voyez **Dicter : ouvrir les réglages Voix**, choisissez ou configurez le moteur à cet endroit, puis revenez au brouillon.
3. Choisissez **Arrêter l'enregistrement et transcrire** pour obtenir le texte ou **Annuler la dictée** pour abandonner l’enregistrement. Changer de conversation ou fermer la zone de saisie annule aussi la dictée.
4. Relisez le texte. Il remplace la sélection d’origine si le brouillon et la sélection n’ont pas changé ; sinon, choisissez **Insérer la transcription** ou **Ignorer la transcription**. La dictée n’envoie jamais le brouillon.

Si l’API utilise le mode WAV de secours sur Tauri sous Linux, **Dicter** et **Tester l’entrée** arrêtent l’enregistrement au bout de 24 secondes. L’extrait reste sur cet appareil jusqu’à ce que vous choisissiez **Transcrire** pour l’envoyer au fournisseur vocal ou **Annuler** pour le supprimer.

### Choisir un moteur sur ordinateur {#desktop-dictation}

Dans les **Préférences → Voix** de l’application de bureau locale, sélectionnez le **Moteur de dictée sur cet appareil**. Ce choix vaut pour tous les projets sur cet appareil ; la carte **Voix** configure toujours l’API du serveur connecté. Le navigateur et le mobile utilisent le fournisseur API configuré et nécessitent un contexte sécurisé pour le microphone.

- La **Reconnaissance système locale** fonctionne dans CodeNomad sans ouvrir le panneau de dictée de l’OS. Elle nécessite un moteur local installé pour la langue de l’application sous Windows ou macOS. Sous Linux, ou si le moteur ou la langue manque, essayez Hex s’il est proposé.
- Voix indique ce qui manque à Hex, le volume à télécharger pour chaque composant et le total. Un clic sur **Activer Hex** vérifie et réutilise les fichiers compatibles, télécharge ce qui manque, puis sélectionne Hex dès qu’il est prêt. Suivez la progression dans Voix ; utilisez **Annuler l’activation de Hex** pour arrêter et **Reprendre l’activation de Hex** lorsque l’action est proposée. En cas d’échec ou d’annulation, le moteur précédent reste sélectionné. Rouvrir les préférences, sélectionner **Hex (local)** déjà prêt ou dicter avec ne déclenche aucun téléchargement.
- Hex est proposé sur les configurations compatibles : Windows x64/arm64, Mac Apple Silicon sous macOS 15 ou plus récent, Linux x64/arm64 avec glibc 2.36 ou plus récente et les bibliothèques requises par Hex. Les Mac Intel et les systèmes Linux avec une glibc plus ancienne ou musl sont incompatibles. Le moteur et les modèles sont séparés de l’installateur CodeNomad ; aucun terminal ni clé API n’est nécessaire.

Ubuntu 24.04 satisfait au prérequis glibc, contrairement à Ubuntu 22.04. Hex détecte la langue parlée parmi les [langues du modèle Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), dont le français et l’anglais. Cette liste est indépendante de la langue de l’application.

La reconnaissance locale utilise le microphone de cet appareil et fonctionne hors ligne, y compris pour les projets WSL ouverts dans l’application locale. Dans une fenêtre distante compatible, **Dicter** ouvre la fenêtre locale **Dicter sur cet appareil**. Vérifiez la destination affichée, puis choisissez **Démarrer la saisie vocale**, **Arrêter l'enregistrement et transcrire** et **Insérer la transcription** pour renvoyer uniquement le texte au brouillon. Le projet distant doit rester connecté à son serveur.

Dans une fenêtre Tauri distante sous Linux, **Tester l'entrée** vérifie l’API vocale du serveur sans changer le moteur de dictée. Vérifiez l’adresse du serveur dans la boîte de dialogue native du microphone avant de confirmer chaque enregistrement pour l’API. La capture utilise PulseAudio ou le service PulseAudio de PipeWire et applique toujours la limite WAV de 24 secondes décrite ci-dessus.

## Lire les messages à voix haute {#playback}

1. Utilisez **Lire le message** sur un message, ou la même action sur un appel d’outil, lorsque TTS est disponible.
2. Utilisez **Arrêter la lecture** sur la même commande pour l’arrêter ; démarrer une autre lecture arrête celle en cours.
3. Changez la voix, le modèle, le mode ou le format enregistrés dans **Voix** pour les demandes suivantes.

La lecture utilise la projection textuelle CodeNomad, pas une capture d’écran racontée : les octets binaires/d’images et les reçus d’autorisation ne sont pas du contenu vocal. Elle n’exécute pas de prompt et ne change pas le modèle OpenCode sélectionné.

Pour la voix automatique de conversation, utilisez **Activer le mode conversation** dans le menu **Plus d'actions** de la zone de saisie ; il s’applique à cet onglet de projet et n’est pas conservé après un rechargement. Tant qu’il est actif, CodeNomad demande à l’agent, avec chaque prompt que vous envoyez, de commencer sa réponse par un court résumé dans un bloc clôturé `spoken`. Seul ce bloc terminé est lu, dans la session principale active ; ce n’est pas une lecture automatique de chaque réponse ou sous-agent. **Desactiver le mode conversation** arrête sa file et ne demande plus le résumé. Démarrer le microphone arrête aussi la voix de conversation active. Le mode conversation nécessite une lecture configurée dans un format pris en charge.

## Flux de données et confidentialité {#privacy}

La dictée locale garde l’audio sur l’appareil et ne bascule jamais vers l’API. Avec **Fournisseur API**, l’audio du microphone passe par le serveur CodeNomad jusqu’au point d’accès de transcription configuré. Le texte sélectionné pour synthèse passe par ce backend vers le point d’accès TTS configuré ; l’audio reçu est lu sur le client. Les clés API restent côté serveur et ne sont pas renvoyées comme valeurs enregistrées au formulaire.

Utilisez un point d’accès de confiance pour le contenu dicté ou lu. Les identifiants OpenCode n’autorisent pas automatiquement la voix. Changer une clé ou un point d’accès affecte les demandes futures, pas les données déjà envoyées. Voir [Sécurité](security.md) avant d’exposer un serveur à d’autres utilisateurs.
