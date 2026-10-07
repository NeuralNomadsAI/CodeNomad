# Missions : cahier des charges d'autonomie dans OpenCode

## Clarification explicite de l'utilisateur — 7 octobre 2026

Cette clarification est une exigence de conception, pas une affirmation que
l'implémentation actuelle est autonome ou qualifiée.

> « oui mais c bien celle que je t'ai demandé depuis le debut, rendre le plugin
> entièrement autonome en déplaçant ces responsabilités dans OpenCode.
> stp arrete de remettre ça en cause et prend le comme cachier des charges une
> bonne fois ppour toute »

L'utilisateur demande expressément de transmettre cette discussion à la session
maître et de conserver cette exigence pour éviter qu'elle se perde.

## Cible obligatoire

- `codenomad.missions` fonctionne de façon autonome **dans le service OpenCode**.
- Missions et tâches programmées fonctionnent lorsque l'interface **et le serveur
  intermédiaire CodeNomad sont fermés** ; le service OpenCode demeure nécessaire.
- CodeNomad configure, affiche et pilote ; son serveur n'est pas une dépendance
  d'exécution permanente.
- Les responsabilités nécessaires à cette autonomie doivent être déplacées côté
  OpenCode : admission, autorisations, environnement/profil, stockage,
  restauration à froid et programmation.
- La persistance du serveur CodeNomad en arrière-plan n'est **pas** la solution
  demandée ni un remplacement acceptable de cette cible.

## Protections et coordination

Les contrôles de sécurité, identités exactes, permissions natives, refus sur état
inconnu et absence de rejeu d'effets incertains restent obligatoires. Les déplacer
ne signifie pas les supprimer ni activer une intégration non qualifiée.

Les dépendances actuelles du plugin envers `sendMissionInput`, les routes
d'admission et le transport du serveur CodeNomad sont des dépendances à déplacer,
pas une justification pour remplacer cette cible par un backend persistant.

La session maître doit réconcilier son plan et ses délégations avec cette
clarification avant de poursuivre les travaux qui supposent ce backend
persistant. Aucun travail préexistant ne doit être supprimé ou annulé sans
inspection ; la clarification décrit la cible, pas une autorisation de nettoyage.
