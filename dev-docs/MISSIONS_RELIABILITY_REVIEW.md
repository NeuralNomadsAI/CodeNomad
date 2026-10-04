# Missions : retour critique sur #824 et continuité V2

Date : 2026-10-01. Sources étudiées : branche `feat/session-native-missions-v2`,
HEAD `bbbc5e3ff9879ef91227b604470df61cc7dfe600`, client/plugin 2.0.21.
Audit de conception et lectures natives ; aucun arrêt de l'application, du daemon,
des sessions ou de la mission, aucune publication. Les propositions ne sont pas implémentées.

## Conclusion

Missions n'est pas un moteur d'exécution V1 réinventé : sessions, files de messages,
exécution et stockage du journal utilisent déjà OpenCode V2. L'UI n'est pas le
coordinateur ; une session racine native l'est.

En revanche, nous avons lié la disponibilité des outils, du contexte de mission
et des échanges entre acteurs à la présence du backend CodeNomad desktop. La
durabilité des données ne garantit donc pas la continuité de la coordination.
Ce choix est incompatible avec une promesse implicite « fermer le client ne change
rien au travail ». Le corriger demande un contrat explicite de fonctionnement sans
desktop, pas la suppression des protections d'environnement et de propriété.

L'interruption native à la fermeture rapportée par l'utilisateur reste à reproduire
isolément : les chemins lus ne prouvent pas un `session.interrupt` lors du quit.
Le badge Interrupted peut aussi être une inférence locale erronée.

## Ce que #824 montre, et ne montre pas

- Une tâche de validation apparaissait Queued et son acteur inactif, alors qu'une
  commande navigateur native en arrière-plan progressait. Le titre de l'acteur
  réutilisé décrivait son ancienne tâche, pas la validation.
- Le run navigateur a réellement fini : 356 pass, 3 fail, 1 skip, exit 1 naturel,
  sources inchangées. L'A/B a ensuite fini. Un résultat rouge n'est ni une mission
  gelée ni une validation verte.
- Le rapport `issue-824-combined-validation.md` distingue désormais la fin du travail
  du succès des gates. Ses reprises ciblées ne remplacent pas le gate complet rouge.
- Après la consigne explicite de suivi, le coordinateur a poursuivi le diagnostic.
  Lecture RPC native : mission `msn_23d76d0a7ff389fd678dce58`, révision 120,
  24 tâches, 23 rapports ; tous ces rapports ont une notification admitted.
  La tâche sans rapport est `browser-mcp-critical-capture`, affectée à
  `ses_b9bbf2004c6d86be3085545ffc`.
- La lecture native `/api/session/active` a confirmé cet acteur running. Son
  `session.get().outcome` était pourtant succeeded : ce champ décrit une issue
  antérieure, pas l'activité actuelle. Ne pas en déduire idle.
- Ces lectures ne prouvent pas que chaque notification a été lue par le modèle,
  ni que notre intervention était nécessaire à la reprise. Elles ne démontrent
  pas non plus une panne générale des missions.

## Fragilités confirmées dans le code

### 1. La disparition du desktop désactive la coordination

`packages/server/src/index.ts` arrête `missionsLifecycle` lors du shutdown.
`opencode/desktop-plugin-installation.ts` retire alors sa lease ; les leases
crashées expirent après 15 secondes (`desktop-plugin-presence.ts`).
`opencode/missions/desktop-plugin.ts` enveloppe Missions dans `followPresence`.
Sans aucune autre présence backend, `setupMissionsPlugin` est disposé : RPC,
outils et hook de contexte sont retirés, l'outbox est arrêtée.

Les exécuteurs déjà capturés par un tour modèle ne restent pas utilisables :
`assertActive()` les refuse après disposal. Le test `missions-plugin.test.ts`
vérifie précisément ce refus. Un acteur peut donc continuer du travail natif mais
ne plus pouvoir utiliser ses outils Mission ou retrouver son contexte au tour suivant.

Ce n'est pas une preuve que le daemon interrompt la session. `WorkspaceManager.shutdown`
ne doit pas évincer les locations ; `OpenCodeSharedService.shutdown` efface seulement
la connexion locale. Le plugin Mission dispose ses registrations sans appeler interrupt.

### 2. Les échanges natifs font un détour obligatoire par le desktop

`opencode/missions/desktop-plugin.ts` fournit le transport de dispatch/notification
à `MissionControl`. `sendMissionInput` dans `opencode/automation-plugin.ts` exige
exactement un backend propriétaire puis son bridge authentifié.

La branche de transport direct `sessions.prompt/synthetic` existe dans
`missions/control.ts`, mais n'est pas celle du plugin livré. Sans backend, aucune
nouvelle admission Mission ne passe. Même si la fenêtre n'a aucun rôle dans cette
admission, fermer le dernier client local emporte son backend.

Ce détour protège la propriété projet/worktree, les mutations, le profil
d'environnement et la sélection native. Le contourner silencieusement serait
une régression de sécurité, notamment avec deux profils propriétaires.

### 3. L'outbox récupère les rapports écrits, pas le travail sans rapport

`missions/notification-outbox.ts` et `control.retryPendingNotifications` récupèrent
uniquement les rapports déjà persistés dont la notification n'est pas admitted.
Ils ne détectent pas un acteur terminé sans `mission.report`, n'achèvent pas une
admission interrompue et ne pilotent pas la prochaine tâche. Un modèle qui conclut
en prose, une disparition des outils avant le rapport ou une erreur terminale peuvent
laisser du travail non clos malgré un journal intact.

Ce comportement est intentionnel et documenté, mais notre expérience utilisateur
attend une continuité plus forte que cette simple récupération de notifications.

### 4. Les états affichés mélangent plusieurs vérités

- `model.ts` transforme task.dispatched en Queued jusqu'au rapport ; aucune
  consommation de l'activité native ne transforme cet état en « travaille ».
- `mission-work.tsx` affiche directement cet état durable.
- mission.status=active / runState=running expriment une mission non terminale et
  autorisée, pas l'activité actuelle des acteurs.
- `session-generation-recovery.ts` transforme ancien working + nouvel idle en
  Interrupted sans recevoir l'issue native. Une session finie normalement pendant
  l'absence du client peut emprunter ce chemin. Cela concerne aussi les sessions
  ordinaires ; ce n'est pas une particularité démontrée de Missions.
- Le bouton Play est désactivé pour une mission running. Il n'existe donc pas une
  action distincte « reprendre le coordinateur inactif » ; Pause/Play n'est pas
  une bonne réparation car Pause interrompt les autres acteurs.

## OpenCode V2 : réutilisé, ou réinventé ?

Les primitives utilisées sont déjà natives : session.create, prompt/synthetic,
delivery=queue, resume=true, inbox durable et storage du plugin.
La carte ajoute objectif, contrats, dépendances, preuves, révisions et critères de
clôture. Supprimer cette carte ferait réapparaître ces préoccupations dans les
prompts et les conversations ; ce module a une utilité distincte.

En revanche, roots + rapport explicite pour tout travail multiplient les chemins
de livraison et les obligations imposées aux modèles. Le subagent natif fournit
déjà lancement d'enfant, résultat foreground/background et notification au parent.
Pour un travail borné appartenant à un seul coordinateur, il mérite d'être le choix
par défaut étudié, plutôt qu'une possibilité extérieure au modèle de mission.

Les roots restent justifiés pour acteurs réutilisables, conversations humaines
indépendantes, interventions directes et durée de vie indépendante du parent.
Le contrat public session.create de la documentation V2 et le client installé
n'exposent pas parentID pour créer arbitrairement un enfant via cet appel.
Le subagent est donc un mode d'exécution à intégrer réellement, pas une étiquette
à ajouter aux roots existants. Ne pas promettre une annulation récursive ou une
meilleure survie des enfants sans tester leurs sémantiques natives.

Recommandation : conserver la carte métier, évaluer une exécution hybride
subagent natif / root natif, et ne pas reconstruire une seconde file de messages.
Les communications root actuelles sont déjà des inputs natifs ; aucun outil
intersession universel remplaçant tout le contrat Mission n'a été établi par cet audit.

## Priorités et critères d'acceptation

### P0 — contrat de continuité et vérité des états

1. Fermer le desktop doit être un détachement, distinct de Pause/Stop. Définir une
   autorisation durable de mission explicitement commencée, son profil/propriété,
   sa révocation et le comportement quand aucun backend n'est disponible.
2. Maintenir journal, contexte et enregistrement des rapports des travaux admis
   indépendamment de la présence de l'UI. Séparer ces opérations des mutations
   desktop et des nouvelles admissions qui exigent les fences actuels.
3. Choisir le transport sans desktop : exécution native autorisée durablement,
   ou backend indépendant de la fenêtre. Décider après prototype isolé ; ne pas
   choisir un profil au hasard ni omettre l'environnement complet par send.
4. Distinguer état du plan, activité native, attente background, intervention
   humaine, admission/notification et dernier résultat. Unknown reste Unknown.
   Ne pas utiliser un timer de silence comme preuve de panne.
5. Au retour, réconcilier les reads natifs autoritaires et le journal. Interrupted
   doit être fondé sur l'issue/événement natif correspondant, pas ancien working.

### P1 — clôture explicite et choix d'exécution

6. Détecter « acteur sans activité connue, sans attente identifiée, tâche sans
   rapport » et « rapport admis, coordinateur sans prochaine action ». Afficher
   le manque de preuve, sans annoncer automatiquement échec ou réussite.
7. Fournir une reprise ciblée, corrélée et bornée du coordinateur / rapport absent,
   distincte d'un replay de tâche. Pas de doublon de prompt de travail, pas de
   retries illimités, respect strict Pause/Stop, erreur provider, Forms et permissions.
8. Séparer « tâche de diagnostic terminée » de « objectif corrigé/validé ». Donner
   un bilan accessible : livré localement, gates, limites, prochaine décision,
   publication/déploiement. Ne pas confondre tâche completed et acceptation produit.
9. Comparer subagent natif et roots sur le même petit scénario ; associer enfant,
   contrat et preuve sans dépendre d'un parsing fragile du texte du transcript.

## Matrice de vérification manquante

Tout doit utiliser CLI/provider/config/DB privés, jamais fermer le client utilisateur.

| Scénario | Invariant à prouver |
| --- | --- |
| Quit pendant un tour modèle puis résultat | session non interrompue par détachement ; état affiché exact au retour |
| Dernière lease retirée pendant un outil/rapport | rapport enregistrable ; aucune perte du contexte/contrat |
| Outil background fini sans desktop | notification native, reprise de l'acteur, rapport puis conclusion sans prompt humain |
| Rapport reçu coordinateur occupé ou absent | un input corrélé ; reprise et consommation distinctes de l'ACK HTTP |
| Admission en vol au quit | même intention récupérable, ni acteur ni travail créé en double |
| Modèle termine sans rapport / provider échoue | manque détecté ; reprise ciblée ou décision humaine, jamais vert implicite |
| Pause/Stop puis fermeture/retour | aucune reprise involontaire, Stop reste terminal |
| Deux profils / propriétaire perdu / worktree déplacé | refus explicite, pas de fallback de sécurité |
| Session ordinaire finit pendant l'absence | fin normale, pas faux Interrupted |
| Subagent foreground/background, parent interrompu | sémantiques mesurées, comparaison avec root, pas de promesse récursive non testée |

Le fixture actuel `scripts/test-missions-native.mjs` vérifie la récupération d'un
rapport **déjà écrit** après perte du bridge et le retour de présence/RPC. Il ne
qualifie pas toute cette chaîne pendant l'absence du desktop.

## Validation et sources

Exécuté : 12 tests, 12 pass, sortie naturelle :
`node --import tsx --test packages/ui/src/stores/session-generation-recovery.test.ts packages/server/src/missions/notification-outbox.test.ts packages/server/src/opencode/missions-plugin.test.ts`.
Cela vérifie les comportements actuels, pas les correctifs proposés ni une
reproduction native complète du quit.

Lectures natives authentifiées via `opencode api` : session.get du coordinateur
et de l'acteur, session.active, RPC snapshot du projet (input vide). Aucun prompt,
interrupt, reload ou modification de stockage utilisateur.

Documentation V2 consultée :
- https://opencode.ai/v2/docs/build/plugins (lifecycle, snapshots d'outils, sessions)
- https://opencode.ai/v2/docs/agents (modes et permissions des enfants)
- https://opencode.ai/v2/docs/tools (subagent foreground/background)
- https://opencode.ai/v2/docs/api et https://opencode.ai/v2/openapi.json

Les pages publiées ne remplacent pas la qualification de la version installée ;
les détails de survie/interruption des enfants restent à vérifier isolément.
