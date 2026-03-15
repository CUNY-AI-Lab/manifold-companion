# @Mentions in Annotations

## Summary

Add @mention support to annotations and replies. Users type `@` in a comment to see a dropdown of project members, select a name, and the mention is stored and rendered as a highlighted span. Scoped to project members only (owner + collaborators).

## Data Model

Add `mentions` TEXT column to `annotations` table (default `'[]'`). Stores JSON array of user IDs, e.g. `[3, 7]`.

## Backend

### Migration (`server/db.js`)

```sql
ALTER TABLE annotations ADD COLUMN mentions TEXT DEFAULT '[]'
```

### New endpoint

`GET /api/texts/:id/mentions/users` — returns project members for autocomplete. Requires viewer+ access. Returns `{ users: [{ id, email, display_name }] }`. Resolves text -> project, then fetches owner + shares.

### Modified endpoints

- `POST /api/texts/:id/annotations` — accept optional `mentions: [userId, ...]`. Validate each is a project member. Store as JSON string.
- `POST /api/texts/:id/annotations/:annotId/replies` — same `mentions` support.
- `GET /api/texts/:id/annotations` and `GET /api/texts/:id/annotations/:annotId` — return parsed `mentions` array and a `mentioned_users` map `{ [userId]: { display_name, email } }` so client can render without extra fetches.

## Client — `AnnotationSidebar.jsx`

### Autocomplete

- On `@` keystroke in textarea, show dropdown filtered by text after `@`
- Fetch project members once when sidebar opens (cache in state)
- Dropdown positioned below textarea, shows name + email
- Selecting inserts `@Display Name` (or `@email` if no name) into text and adds user ID to local `mentions` array
- Escape or clicking away dismisses dropdown

### Rendering

- Comment body: parse text for `@Name` patterns matching `mentions` user IDs
- Wrap matches in `<span className="text-cail-blue font-medium">`

### Storage

- `body` field: raw text with `@Name` inline (human-readable)
- `mentions` field: `[userId, ...]` (machine-queryable, used for future notifications)
