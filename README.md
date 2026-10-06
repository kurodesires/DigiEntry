# DigiEntry · Asian College of Technology, Bulacao Campus

DigiEntry has two separate experiences: a public visitor request page and an authenticated campus staff dashboard. The Node server stores requests and accounts in SQLite, emails every decision with a standards-compliant QR pass, and exposes a one-time scanner verification API.

## Run locally

Requirements: Node.js 22.13 or newer.

1. Copy `.env.example` to `.env` and set mail settings and the scanner key.
2. Install packages with `npm install`.
3. Start the app with `npm start`.
4. Open `http://localhost:3000`. Visitors use Enter. Campus staff sign in at `/admin.html`; account creation is at `/create-account.html`.

SQLite data is stored in `data/digientry.sqlite`. On Render, its default filesystem is temporary. To keep accounts and visitor requests after restarts, attach a persistent disk mounted at `/var/data` and set the `DATA_DIR` environment variable to `/var/data`. Persistent disks require a paid Render web service. If both devices use the same deployed URL and data still disappears, check that the service has this disk configured. Back up the database regularly. Serve the app over HTTPS in production; the session cookie gains the Secure flag when `NODE_ENV=production`.

## Required configuration

Email is sent through Gmail SMTP using `digientrypass@gmail.com`. Decisions are held as pending if mail cannot be sent, so a visitor never gets an unemailed decision. Set `SMTP_PASS` to a Google App Password; do not use the account's normal password. App Passwords require 2-Step Verification on the Google account.

- `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER=digientrypass@gmail.com`, `SMTP_PASS`, `MAIL_FROM`: Gmail email transport.
- `SCANNER_API_KEY`: long random key provisioned to the physical scanner.
- `DATA_DIR`: optional persistent SQLite directory.
- `PORT`: optional web port.

## Scanner connection

The emailed QR contains a cryptographically random opaque token. A scanner decodes that QR, then sends:

```http
POST /api/scanner/verify
Authorization: Bearer <SCANNER_API_KEY>
Content-Type: application/json

{"token":"<decoded QR contents>"}
```

A valid approved pass returns `{"valid":true,"decision":"accepted","message":"You may enter the campus."}` and changes the request to checked in. A declined pass returns `decision: "declined"` and the requested message. A previously accepted and scanned pass returns `decision: "already_used"`. Invalid, pending, and declined passes must never produce a green access signal. The scanner should show green only when both HTTP status is 200 and `valid` is true; show red for every other response, timeout, or parse error. Use HTTPS between the device and server. Keep the scanner key on the device; do not put it in visitor-facing browser code.

The staff dashboard does not include a QR scan panel. The hardware scanner continues to use the scanner API above.

## Account security

Staff accounts use the shared ACTSTAFF password, accepted regardless of letter case. Staff account registration asks for a name and campus rank. Deploy behind HTTPS with a persistent private disk and managed SMTP credentials.

## Cloudflare deployment with persistent D1 storage

The Cloudflare Worker implementation is in `worker.js`; it uses D1 for staff accounts, sessions, visitor requests, decisions, and one-time QR check-ins. The `build:cloudflare` script copies only the public HTML, CSS, and browser JavaScript into `public/`, so local databases, `.env`, migration files, and server code are not uploaded as public assets.

1. Install Node.js 22 or newer, then run `npm ci` and `npx wrangler login` from the project folder.
2. Apply the schema to the existing Cloudflare D1 database: `npx wrangler d1 migrations apply digientry --remote`.
3. To import this computer's SQLite data, run `npm run export:sqlite`, then `npx wrangler d1 execute digientry --remote --file=./data/d1-import.sql`. The export includes staff and visitor requests, including existing QR hashes, but not browser sessions; staff sign in again afterward. The SQL export contains private visitor details and is ignored by Git.
4. In Cloudflare, open the `digientry` Worker settings and add these runtime secrets/variables: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=digientrypass@gmail.com`, `SMTP_PASS` (a newly created Google App Password), `MAIL_FROM=DigiEntry <digientrypass@gmail.com>`, and `SCANNER_API_KEY` (the same key set on the scanner).
5. Connect the GitHub repository in Workers Builds. Set Build command to `npm run build:cloudflare` and Deploy command to `npx wrangler deploy`. Push the prepared changes to `main` to deploy.

The local `data/digientry.sqlite` file and a deployed Render database are separate stores. `npm run export:sqlite` only exports the local file; it cannot retrieve data held by Render. Export any records from the current live service before switching visitors to Cloudflare. Rotate any Google App Password previously shared in a chat before adding its replacement to Cloudflare Secrets.

Cloudflare Workers sends Gmail mail over encrypted SMTP on port 465 using the Workers TCP Sockets API. It does not use the local server's port 587 configuration.


