# 📁 FileDrop

AirDrop-style file transfer between your Mac and Android phone over your home Wi-Fi —
no cloud, no account, and a **fresh PIN required for every pairing** so no random
device can ever send you files or read yours.

## How it works

A small server runs on the Mac. The phone opens a web page in Chrome — nothing to
install. Pairing requires the 6-digit PIN shown only on the Mac.

```
┌─────────── Mac ───────────┐         ┌────────── Pixel ──────────┐
│ node server.js            │  Wi-Fi  │ Chrome → http://mac-ip    │
│ localhost:8090/admin      │ ◄─────► │ enter PIN → send/receive  │
│ shows PIN + QR code       │         │                           │
└───────────────────────────┘         └───────────────────────────┘
```

## Usage

1. On the Mac (both devices on the same Wi-Fi):

   ```sh
   npm install   # first time only
   npm start
   ```

2. Open **http://localhost:8090/admin** on the Mac — it shows a QR code and the current PIN.
3. Scan the QR code with the Pixel camera (or type the URL into Chrome).
4. Enter the PIN from the Mac's screen on the phone.
5. Transfer:
   - **Phone → Mac**: tap *Send to Mac*, pick files. They land in `~/Downloads/FileDrop`.
   - **Mac → Phone**: drag files into the *Outbox* on the admin page; they appear on the
     phone under *From Mac* with a Download button.

Tip: in Chrome on the phone, ⋮ → *Add to Home screen* gives you an app icon.

## Security model

- **PIN on every attempt** — a device can only pair by entering the 6-digit PIN
  displayed on the Mac. The PIN is generated with a CSPRNG and **rotates after every
  successful pairing**, after 5 failed attempts, every 10 minutes if unused, and on demand.
- **Brute-force lockout** — 5 wrong guesses locks that IP out for 60 s and rotates the PIN.
  PIN comparison is constant-time.
- **Short-lived sessions** — pairing grants a random 256-bit token in an
  `HttpOnly; SameSite=Strict` cookie, valid for 15 minutes. After that, re-pair with a new PIN.
- **End a session early** — *Disconnect* on the phone, or *End all sessions* on the Mac's
  admin page (which also rotates the PIN), revokes access immediately.
- **Admin is localhost-only** — the page showing the PIN, QR code, and received files
  rejects any request not coming from the Mac itself.
- **Path safety** — uploaded filenames are sanitized (no traversal, no control chars) and
  downloads are restricted to files inside the outbox directory.

Traffic is plain HTTP on your LAN. That's fine on a trusted home network; avoid using it
on public Wi-Fi (or put it behind a VPN like Tailscale, which also makes it work
across networks).

## Configuration

| Env var | Default | |
|---|---|---|
| `FILEDROP_PORT` | `8090` | Port to listen on |
| `FILEDROP_RECEIVED_DIR` | `~/Downloads/FileDrop` | Where phone uploads are saved |
| `FILEDROP_OUTBOX_DIR` | `./outbox` | Files shared to the phone |

macOS will ask "Allow node to accept incoming connections?" the first time — click Allow.
