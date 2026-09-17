# Anion design system

`tokens/tokens.css` and `scss/_breakpoints.scss` are copied from the sibling
`anion` frontend. Keep these files in sync with that source; desktop-only layout
rules belong in `src/styles.scss` or the shell component.

The bookmarks, seasons, schedule and search pages reuse the frontend's templates
and component styles. Desktop adaptations retain the Tauri API transport, local
routes and server-owned watch progress. Bookmark episode counts are read-only;
season genre badges remain labels because the desktop catalog has no genre route.

Visual verification uses a temporary localhost fixture server, not production
account mutations. No fixture transport is included in the application build.
