# Missions : cahier des charges d'autonomie dans OpenCode

## Cible obligatoire (clarification de l'utilisateur, 7 octobre 2026)

- `codenomad.missions` fonctionne de façon autonome **dans le service OpenCode**.
- Missions et tâches programmées fonctionnent lorsque l'interface **et le serveur
  intermédiaire CodeNomad sont fermés** ; le service OpenCode demeure nécessaire.
- CodeNomad configure, affiche et pilote ; son serveur n'est pas une dépendance
  d'exécution permanente.
- Les responsabilités nécessaires à cette autonomie doivent être déplacées côté
  OpenCode : admission, autorisations, environnement/profil, stockage et
  programmation pendant que le service fonctionne.
- La persistance du serveur CodeNomad en arrière-plan n'est **pas** la solution
  demandée ni un remplacement acceptable de cette cible.
