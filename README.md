# FC Manager

Desktop app for managing a football club's students: profiles, groups, monthly fees and other payments
(kit, clothes, camps), attendance, and contracts generated from templates. English and Armenian UI.

## Using it on several PCs

One PC is the **main computer (host)**: it keeps the database and shares it on the local network.
Other PCs choose **Connect to the main computer** on first launch, pick it from the list (or type its
address) and enter the **access code** shown on the host under *Settings → Network & backups*.

- The host must be on, with FC Manager running, while others work.
- Changes made on any PC show up on the others within a few seconds.
- On first start Windows Firewall asks about FC Manager on the host — allow it for **private networks**.
  It uses TCP port 47800 (data) and UDP port 47801 (finding the host automatically).
- The host makes a backup every day (last 30 kept) in its backups folder; *Back up now* and
  *Restore from backup* are in Settings. Copy backups off the PC from time to time.

## Development

```bash
npm install
npm run dev      # Vite + Electron with hot reload
npm start        # build and run once
npm run dist     # Windows installer in release/
```

Set `FC_USER_DATA=<folder>` to run a second copy with separate data on the same PC (e.g. host + client for testing).

### Layout

- `electron/db.js` – SQLite schema and migrations (Electron's built-in `node:sqlite`, no native modules)
- `electron/service.js` – all data operations; one `call(method, params)` entry point
- `electron/network.js` – host HTTP server, UDP discovery, and the client that forwards calls to the host
- `electron/main.js` – window, per-PC config, IPC, backups, PDF/print
- `src/` – React UI (`pages/`, `components/ui.jsx`, translations in `locales.js`)

Monthly fee charges are generated automatically for each active student from *Settings → Start billing
from* onward and become overdue after the due day. They can be waived but not deleted.
