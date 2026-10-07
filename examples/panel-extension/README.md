# Independent CodeNomad panel extension starter

Copy this folder to **your own GitHub repository**. Replace the `example.session`
identity, author and repository in `manifest.json`, and give your repository a
license. The sample is MIT-licensed. No CodeNomad source imports or build tool are
needed; it only displays the current session identifier, with English/French text
and appearance changes.

From this directory:

```sh
python -m zipfile -c example.session-1.0.0.zip manifest.json panel.html
python -c "import hashlib,pathlib; p=pathlib.Path('example.session-1.0.0.zip'); pathlib.Path(str(p)+'.sha256').write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')"
```

Publish both files as assets of release `v1.0.0` on your repository. Users download
the ZIP, inspect/install it through Customize right panel → Extensions, then
check its entry in Customize right panel to enable it for their CodeNomad profile.
GitHub's source-code ZIP is not the
installable package. New code requires a new release/version and explicit trust;
activation is revoked on replacement.

API compatibility is `apiVersion: 1`, not the exact CodeNomad version. This sample
cannot read messages/images or access files, OpenCode, native commands or network
APIs. It is a distribution smoke example, **not** the planned assets gallery.
See `dev-docs/PANEL_EXTENSIONS.md` in the CodeNomad repository for the public
contract, packaging rules, lifecycle and security limits.
