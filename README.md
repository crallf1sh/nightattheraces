# Night at the Races

Self-hosted internal event software for a staff elimination-and-prize event. It uses Express, Socket.IO, SQLite, and SheetJS; no cloud database or API key is required.

## Run locally

Prerequisites: Node.js 20+ and a build toolchain suitable for `better-sqlite3` (normally already present on a server with Node). From this directory:

```bash
npm install
npm start
```

Open `http://localhost:3000/admin` for the operator console and `http://localhost:3000/screen` on the audience display. `/` redirects to `/admin`. Set `PORT=8080` to change the listener. Set `DATABASE_FILE=/secure/path/races.sqlite` to put the database outside the application directory. Optionally set `ADMIN_PASSWORD` to enable HTTP Basic authentication for `/admin` and API calls; keep the Big Screen URL accessible on a trusted internal network.

### HR quick start

For a Mac, unzip the delivery, then double-click `run-local.command`. If macOS warns that it cannot open the file, Control-click it, choose **Open**, then approve it once. For Windows, double-click `run-local.bat`. Both launchers install the app packages on first run only, open Admin automatically, and keep the event server running for the duration of the event. Install Node.js 20+ once from [nodejs.org](https://nodejs.org/) on each operator computer.

For a two-computer event on the same trusted network, run the launcher on the operator laptop, find its local network address (for example `192.168.1.25`), and open `http://192.168.1.25:3000/screen` on the display computer. Keep both machines on the same network and allow the Node application through the local firewall if prompted.

## Event operations

Download the roster template from Admin. It requires `First Name` and `Last Name` columns; replace the example rows, save as `.xlsx`, upload, inspect the preview, then create the event. Duplicate display names are rejected deliberately—add a distinguishing initial so the operator can identify the person clearly. The server assigns each imported participant a stable UUID.

Configure each standard round as a count or percentage. The app will not allow a target that drops below four remaining participants. When four remain, the current standard round is completed, its gift-card draw is made with server-side cryptographic randomness, and Final Four mode begins. Final Four eliminations are deliberate, individual actions and stay on the Big Screen until dismissed.

The “Start New Event” safeguard means you must archive the active event by typing `RESET`; it never overwrites an event with one click. Manual restore is a compensating action retained in history. Undo only reverses the latest safe standard elimination.

## Backup, restore, and recovery

Use **Download Event Backup** at any time and store the JSON outside the event computer. Restore requires a valid exported JSON file and typing `RESTORE`; the currently active event is safety-archived first. Every committed state change is in a SQLite transaction and generates a rolling checkpoint (the 40 newest are retained). Use Recovery Checkpoints and type `CHECKPOINT` to roll back; that action is also recorded.

For a server backup, stop the app and copy the SQLite file (default `data/races.sqlite`) plus its `-wal` and `-shm` files if present, or use the JSON backup while the app is running. For a restore on a new server, start the app, open Admin, and use Restore Backup.

## Deployment

Run behind an internal reverse proxy such as Nginx or Caddy, proxying both HTTP and WebSocket upgrades to the Node port. Persist the `data/` directory (or use `DATABASE_FILE` on a persistent mounted volume), run under a service manager, and restrict access to your trusted network/VPN. Configure `ADMIN_PASSWORD` if the network is not fully trusted. Socket.IO must be allowed to use WebSocket/polling and forwarded with Upgrade/Connection headers.

### Simplest server deployment: Docker

The included `Dockerfile` and `compose.yaml` mean the web server does **not** need Node.js, npm, SQLite, or any application packages installed. It only needs Docker Engine with the Compose plugin. Copy this project to the server, optionally create a `.env` file containing `ADMIN_PASSWORD=your-long-password`, then run:

```bash
docker compose up -d --build
```

Open `http://server-name:3000/admin`. Docker installs the application dependencies while it builds the image; the running server has one container and a persistent `event-data/` folder beside the Compose file. Back up that folder or use the in-app JSON backup. To update an approved build, replace the project files and run `docker compose up -d --build` again; the mounted event data is preserved. For an air-gapped server, build the image on a connected machine with `docker compose build`, transfer it with `docker save -o night-at-the-races.tar night-at-the-races:latest`, load it on the server with `docker load -i night-at-the-races.tar`, and run `docker compose up -d`.

GitHub is optional. It can store the source privately and help IT track changes, but it is not needed to run the event and should not hold live event backups or the SQLite database. For a stable internal web address, the Docker option on an IT-managed internal server is the recommended approach.

`public/okc-thunder-logo.svg` is the organization logo supplied for this event. To replace it, update the two image references in `public/admin.html` and `public/screen.html` to an approved local SVG/PNG.

## Testing checklist

- Import the sample template; confirm blank/duplicate/error previews prevent creation.
- Create an event, configure a round, eliminate names, end a round, and confirm the gift-card winner is from that round only.
- Open `/screen` in a second browser; verify a committed elimination animates and refresh/reconnect reconstructs the current board without replay.
- Restart `npm start`; confirm the event resumes.
- Download a JSON backup, make a change, then restore it and confirm the prior event is archived.
- Inspect checkpoints and restore one in a test event.

## Product assumptions

The physical-draw workflow treats the selected drawn name as authoritative. “Process Next Random Name” uses `crypto.randomInt` on the server. A standard round that reaches exactly four automatically closes and selects that round’s gift-card winner so no standard round can end without one. Final Four corrections are intentionally handled through checkpoints/backup restoration rather than silently changing placements.
