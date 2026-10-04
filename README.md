# DigiEntry · Asian College of Technology, Bulacao Campus

DigiEntry has two separate experiences: a public visitor request page and an authenticated campus staff dashboard. The Node server stores requests and accounts in SQLite, emails every decision with a standards-compliant QR pass, and exposes a one-time scanner verification API.

## Run locally

Requirements: Node.js 22.13 or newer.

1. Copy `.env.example` to `.env` and set mail settings and the scanner key.
2. Install packages with `npm install`.
3. Start the app with `npm start`.
4. Open `http://localhost:3000`. Visitors use Enter. Campus staff sign in at `/admin.html`; account creation is at `/create-account.html`.

SQLite data is stored in `data/digientry.sqlite`. Keep the data directory on a persistent disk when hosting. Back it up regularly. Serve the app over HTTPS in production; the session cookie gains the Secure flag when `NODE_ENV=production`.

## Required configuration

Email is sent through SMTP using a school mailbox or a transactional email provider. Decisions are held as pending if mail cannot be sent, so a visitor never gets an unemailed decision. Use an app password or provider credential, not an account's normal password.

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`: email transport.
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
