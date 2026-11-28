# Missions : cahier des charges d'autonomie dans OpenCode

## Cible obligatoire

- `codenomad.missions` s'exécute **dans le service OpenCode**.
- Missions et tâches programmées fonctionnent lorsque l'interface **et le serveur
  intermédiaire CodeNomad sont fermés** ; le service OpenCode demeure nécessaire.
- CodeNomad configure, affiche et pilote.
- Admission, autorisations, environnement/profil, stockage et programmation
  s'exécutent côté OpenCode pendant que le service fonctionne.
- Ne jamais satisfaire cette cible par un serveur CodeNomad persistant en arrière-plan.

## Responsabilités

- Les Automations natives d'OpenCode persistent les échéances et lancent les Missions
  programmées (`MISSIONS.md`, §Mission calendar tool).
