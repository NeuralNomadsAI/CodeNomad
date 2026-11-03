# Missions : cahier des charges d'autonomie dans OpenCode

## Cible obligatoire

- `codenomad.missions` fonctionne de façon autonome **dans le service OpenCode**.
- Missions et tâches programmées fonctionnent lorsque l'interface **et le serveur
  intermédiaire CodeNomad sont fermés** ; le service OpenCode demeure nécessaire.
- CodeNomad configure, affiche et pilote ; l'exécution dépend du seul service OpenCode.
- Admission, autorisations, environnement/profil, stockage et programmation
  s'exécutent côté OpenCode pendant que le service fonctionne.
- Ne jamais satisfaire cette cible par un serveur CodeNomad persistant en arrière-plan.

## Responsabilités

- Les calendriers natifs OpenCode persistent les échéances et réveillent leur
  Location après redémarrage. Une programmation saine en marche récupère son
  calendrier automatiquement ; Pause, Stop, erreur et incertitude gardent leurs
  barrières d'admission.
- Missions admet les passages, fige leurs entrées, empêche les chevauchements et
  clôture après corrélation terminale et repos de toute la famille. La récupération
  conserve les identités originales du passage et de son premier message.

Contrats : [programmations et récupération](MISSIONS_RECURRING.md) et
[transport natif](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md).
