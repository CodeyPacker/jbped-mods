# Notifyr

Records every notification Herdr shows in a layout and lists them later.

## How it works

Herdr has no notification history and no event for one. A layout's root `"toast": "<mod>"` names the mod that draws every notification, Herdr's own and every `notify()`. Notifyr is that mod: it draws the toast as Herdr's `toast` mod does and adds it to the record when the toast appears.

One mod, three views, chosen by props:

| View | Props | Where |
|---|---|---|
| toast | `{title, body, level, icon, action, timeout, overlay}` from Herdr | the layout root's `"toast": "notifyr"` |
| bell | `{ "bell": true }`, optional `"bare": true` | a block in your layout |
| list | none, or `{ "list": true }` | `mod.open:notifyr`, a dialog 440px wide and 70% high |

## The bell

```json
{ "id": "notifyr-bell", "type": "block", "size": { "px": 48 }, "content": { "mod": "notifyr", "props": { "bell": true } } }
```

- It shows a bell in `muted`. With unread entries it turns `accent` and shows the count, up to "99+".
- A click runs `mod.open {name: "notifyr"}`.
- It draws the status bar's `chrome` background and top border. `"bare": true` drops both, for a place with its own background such as a tab bar row.

## The list

- Newest first. Each row has the level dot (or the toast's icon), the title, the whole body and the time: "now", "5m", "3h", then "Nov 16". The tooltip on the time is the full date and time.
- Entries that arrived since the list was last opened have an `accent` dot and time. Opening the list marks everything read, and so does closing it.
- A row whose toast had an action is clickable: it closes the list and runs that command with the stored arguments. If the target is gone (a closed terminal), Herdr reports the error.
- Clear empties the record.
- If the shown layout's root does not name `notifyr` as its toast mod, a line at the top says so.

## Stored state

Shared values, saved by Herdr in `shared.json`:

- `notifyr.log`: at most 200 entries, newest first: `{ id, at, overlay, title, body, level, icon, action }`. `at` is milliseconds since 1970, taken when the toast appeared. `body` is cut at 600 characters.
- `notifyr.seen`: when the list was last opened or closed.

Any mod can read them with `shared("notifyr.log")`.

## Limits

- Only layouts whose root names `notifyr` are recorded. Toasts shown before install, on another layout, or while the window is closed are not in the list.
- It replaces Herdr's toast mod in that layout, so later changes to Herdr's toasts do not reach it.
- The list is a centered dialog, not a menu at the bell.
- The list has no keyboard navigation beyond `escape`.
