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
- **Keep OpenCode running** supervise la vie du service natif au niveau du système
  d'exploitation. Cette préférence partagée par le service reste indépendante du
  nombre de Missions et des profils CodeNomad ; le premier Play active un choix
  encore absent, et un OFF explicite persiste. OFF laisse OpenCode fonctionner.
- Windows, macOS et WSL démarrent à la connexion utilisateur. Linux natif utilise
  linger avec les permissions et gardes de restauration du compte. Veille,
  hibernation, durée de vie WSL et contrôle de l'hôte restent des limites propres.

Contrats : [programmations et récupération](MISSIONS_RECURRING.md),
[transport natif](MISSIONS_NATIVE_SCHEDULE_TRANSPORT.md) et
[supervision du service](OPENCODE_RUNTIME_SETUP.md#service-supervision-primitives-and-native-adapters).
