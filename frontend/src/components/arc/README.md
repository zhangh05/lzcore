# Arc UI components

Free components from [Arc UI](https://uiarc.dev) (MIT, see LICENSE), fetched from `https://uiarc.dev/r/<name>.json` with their registry dependencies. Use them by their documented props; lay them out from page CSS, do not restyle their internals.

React 18 compatibility (Arc targets React 19 typings), kept as small patches:

- `button/button.tsx`: `LabelPhase` wrapped in `forwardRef` so `AnimatePresence mode="popLayout"` can measure it.
- `tabs/tabs.tsx`, `drawer/drawer.tsx`: context refs typed `MutableRefObject`.
- `sortable-data-table/sortable-data-table.tsx`: checkbox ref cast for React 18 `RefObject`; optional `messages` prop so the selection and sort strings can be localized (defaults unchanged).

Not vendored: `confirm-morph` (relies on React 19 boolean `inert`); the app keeps its type-to-confirm dialog.

To add another component, fetch it the same way, keep these patches, and run `npm run typecheck`.
