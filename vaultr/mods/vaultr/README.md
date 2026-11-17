# Vaultr

A read-only reader for an Obsidian vault, as a Herdr mod. A folder tree and a name search on the left, the note on the right.

## Install

1. Copy `mods/vaultr/` to `~/.config/herdr-app/mods/vaultr/`.
2. Merge `keys.json` into `~/.config/herdr-app/keys.json`. It binds `ctrl-shift-y` to `mod.open:vaultr`, which opens the dialog and closes it again.
3. Run `herdr-app check ~/.config/herdr-app/mods/vaultr`.

## The vault folder

The first time it opens, Vaultr asks for the vault: type the path and press `enter`, or click Browse. The folder is kept in Herdr's shared state as `vaultr.vault`, so the dialog, tabs and panes all read the same vault. "change vault" at the bottom right, or the `vaultr.vault` command, asks again.

The folder must be inside your home folder. Herdr only lets a mod read files there, and Vaultr says so when the folder is outside it.

One copy can read a different vault through its props: `{ "vault": "<folder>", "note": "<path below the vault>" }`. `note` is optional.

## Where it opens

| How | Command |
|---|---|
| A dialog over the window | `mod.open {"name": "vaultr"}` (`ctrl-shift-y`) |
| A tab | `tab.new {"name": "Vault", "mod": "vaultr"}` |
| Beside the focused pane | `pane.split {"direction": "right", "mod": "vaultr"}` |

All three are in the palette as "Vaultr: Open", "Vaultr: Open in a tab" and "Vaultr: Open beside this pane". The palette also has "Vaultr: Change vault" (`vaultr.vault`) and "Vaultr: Reload" (`vaultr.reload`), which act on the copy that is showing.

Narrower than 620px, the list and the note take turns: opening a note hides the list, and `b` or the ☰ button brings it back.

Vaultr opens on the note it last showed in that vault, and remembers which folders were open.

## Keys

The keys work while Vaultr has the keyboard: click it, or move onto it with `pane.go`.

| Key | Action |
|---|---|
| `/` | put the cursor in the search box |
| `j` / `down`, `k` / `up` | move down / up the list |
| `enter` | open the selected note, or open and close the selected folder |
| `l` / `right`, `h` / `left` | open / close the selected folder |
| `]` / `[` | scroll to the next / previous heading |
| `backspace` | back to the note before |
| `b` | show or hide the list |
| `o` | open the note in Obsidian |
| `r` | read the vault again |
| `escape` | leave the search box, or clear the search |

In the search box, `down` and `up` move through the results and `enter` opens the selected one, or the first.

In the dialog, `escape` always closes the dialog. Herdr handles it before the mod does.

## What is drawn

- Markdown as Herdr's text view draws it: headings, lists, task lists, tables, quotes, code blocks with a language label, links.
- The properties block (frontmatter) as a box of plain lines above the note.
- `[[Note]]`, `[[Note|alias]]`, `[[Note#Heading]]`, `[[#Heading]]` and `[text](Other note.md)` as links that open in Vaultr. A link to a file that is not a note opens in that file's own app.
- `![[image.png]]` and `![alt](image.png)` as the picture, at most 720px wide.
- `> [!note] Title` callouts as a quote with a bold first line. They have no icon or color, and do not fold.
- `==highlight==` as bold. `%%comments%%` are left out.
- Backlinks under the note, once the vault has been read.

A link finds its note the way Obsidian does: a path from the vault's root, then a path from the note's own folder, then the same name anywhere in the vault.

## What is not drawn

- Mermaid, Dataview and other plugin blocks show as code.
- `![[Note]]` shows a link to the note, not its text.
- Canvas files, PDFs and other attachments are not in the list. A link to one opens it in its own app.
- Images on the web (`![alt](https://…)`) are not fetched.
- Block links (`[[Note#^id]]`) open the note at its top.
- Tags are plain text. There is no tag list, graph or search inside notes.
- An animated GIF may show one frame. This has not been tested.

## Limits

- Read-only. Edit in Obsidian (`o`).
- The vault must be on this computer and inside your home folder.
- Folders whose name starts with a dot, and `node_modules`, are skipped.
- Search shows at most 200 notes.
- Backlinks need every note read once. Measured at about 18 ms a note, so a vault of 280 notes takes about 5 seconds. The note you opened shows first.
- The list draws every row of every open folder. It was tested with 280 notes.
- `[` and `]` scroll as little as needed, so near the end of a note a heading may not reach the top.
- Each image you view is copied to `~/.config/herdr-app/data/vaultr/<vault id>/`, because Herdr only draws images from its own folder. The copies are refreshed when the file changes and are never removed. Delete the folder to clear them.
- On Linux, Herdr refuses to watch a vault with more than 4096 folders. Vaultr then stops following changes. Press `r` to read the vault again.
- Only Windows has been tested. The macOS and Linux paths (`cp`, `open`, `xdg-open`) have not been run.

## Files

- `main.js`: the view.
- `md.js`: Obsidian markdown to what the text view draws.
- `vault.js`: which file a link names, and the list's rows.
- `platform.js`: opening a URL and copying a file on each system.

`md.js` and `vault.js` have tests: `sh vaultr/tests/run.sh` in the repo.
