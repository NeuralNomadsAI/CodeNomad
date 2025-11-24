((typescript-ts-mode
  . ((eglot-workspace-configuration
      . (:typescript.format (:indentSize 2
                             :tabSize 2
                             :convertTabsToSpaces t
                             :semicolons "remove")
         :javascript.format (:indentSize 2
                             :tabSize 2
                             :convertTabsToSpaces t
                             :semicolons "remove"))))))
