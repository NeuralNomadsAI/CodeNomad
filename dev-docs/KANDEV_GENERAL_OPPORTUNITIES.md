# Kandev — opportunités générales pour CodeNomad, hors PR #673

Chemin local : `D:\CodeNomad-worktrees\missions-v2\dev-docs\KANDEV_GENERAL_OPPORTUNITIES.md`.

Ce document prépare **d’autres sessions**. Il n’autorise ni implémentation dans #673,
ni déploiement d’infrastructure. Les suites spécifiquement liées aux Missions
(multi-dépôts et partage de gabarits/synthèses) restent dans `MISSIONS_KANDEV_ROADMAP.md`.

Source comparative : `D:\kandev`, checkout observé `359b5ffdb`. L’exploration initiale
était principalement consacrée aux Missions : cette liste est un point de départ,
pas un inventaire exhaustif des bonnes idées de Kandev. D’autres pistes UI/UX,
contexte, review ou intégrations pourront être découvertes dans les sessions suivantes.

## Pistes à vérifier et prioriser

| Piste | Intérêt pour CodeNomad | Preuve disponible et prochaine investigation |
| --- | --- | --- |
| Inbox globale des demandes humaines | Retrouver les questions/permissions de toutes les sessions, même sans mission | Kandev câble snooze/dismiss dans `apps/web/components/needs-you-inbox/needs-you-inbox-row.tsx`. Réutiliser les autorités natives OpenCode ; le regroupement des seuls acteurs d’une mission appartient déjà à #673. |
| Résumé de changement / walkthrough relié au diff | Faciliter revue et livraison, indépendamment des Missions | Fonction documentée dans Kandev ; retracer génération et rendu avant estimation. Comparer au diff et aux outils natifs déjà présents dans CodeNomad. |
| Actions utilitaires ciblées | Réduire les opérations répétitives : résumer, reformuler, préparer une PR | Interfaces/docs trouvées, parcours runtime non entièrement vérifié. Comparer d’abord commandes et sous-agents natifs pour éviter les doublons. |
| Profils d’environnement et diagnostic de connexion | Comprendre où travaille une session et pourquoi son lancement échoue | Examiner profils, états de connexion et diagnostics Kandev. Intérêt possible même sans nouveau système d’exécuteurs. |
| Références de secrets nommées | Simplifier les profils et intégrations | Besoin à confirmer avec les mécanismes OpenCode/OS existants ; aucune justification acquise pour un nouveau coffre CodeNomad. |

## Docker, SSH, Sprite/cloud

Kandev câble ses preparers Docker, SSH et Sprites dans
`apps/backend/internal/backendapp/agents.go`. `docs/public/executors.md` décrit leurs
conditions. Ils n’ont pas été déployés durant l’étude ; aucun prix ou gain de performance
n’a été mesuré.

| Option | Valeur réelle | Charge et question d’intégration |
| --- | --- | --- |
| Worktrees locaux | Isolation Git déjà disponible | Point de comparaison ; ce n’est pas de l’isolation système. |
| Docker local | Dépendances reproductibles et séparation des environnements | Daemon, images, volumes, credentials et cycle de vie. Quel problème utilisateur concret résout-il ? |
| SSH | Utiliser une machine distante maîtrisée | Connexion, chemins, fichiers et reconnexion. Premier spike distant possible lorsqu’un hôte existe déjà. |
| Sprite/cloud | Calcul distant sans maintenir soi-même la machine | Provider, facturation, persistance, nettoyage et reprise. Valider un besoin et un parcours natif avant adoption. |
| Docker distant | Combiner machine distante et isolation conteneur | Complexité cumulée ; à évaluer séparément. |

CodeNomad reste client OpenCode V2. Une intégration pertinente connecterait ou
provisionnerait un environnement **où OpenCode reste le moteur natif**. L’accès distant
à l’interface CodeNomad n’est pas l’exécution distante des sessions.

## Garde-fous de comparaison

- Distinguer code réellement câblé, documentation et concepts derrière un flag.
- Ne pas importer l’architecture Go ou le runtime d’exécution de Kandev.
- La voix existe déjà dans CodeNomad (`packages/server/src/server/routes/speech.ts`) :
  comparer les parcours plutôt que présenter la capacité entière comme manquante.
- Pour chaque nouvelle piste, consigner bénéfice, existant CodeNomad, preuves Kandev,
  coût relatif et critères d’acceptation avant de décider de l’implémenter.
