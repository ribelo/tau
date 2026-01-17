# editor-hub (pi extension)

A small composition layer so multiple tau extensions can contribute editor behavior without overwriting each other.

Why: pi supports only one active editor component. If multiple extensions call `ctx.ui.setEditorComponent(...)`, the last one wins.

`editor-hub` installs a single editor and lets other extensions register plugins that:
- wrap the autocomplete provider
- wrap rendering
- run hooks after input

This is internal tau infrastructure.
