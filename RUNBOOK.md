# Runbook

## Setup Notes

`./setup.sh` installs three separate things:

- the `omp-mobile` launcher in `~/.bin/omp-mobile`
- the `omp-mobile` systemd unit in `/etc/systemd/system/omp-mobile.service`

It also installs the global OMP package (`@oh-my-pi/pi-coding-agent`) when missing and installs web app dependencies with Bun.
Slash commands, including `/review` when OMP exposes it, come from OMP/ACP command discovery. There are no legacy Pi plugin packages to install or copy from this repo.

## systemd service

The repo-owned unit file lives at [`systemd/omp-mobile.service`](./systemd/omp-mobile.service).
`./setup.sh` templates it with your current user, Bun path, repo path, host, and port, then installs it to `/etc/systemd/system/omp-mobile.service`.

Host selection during setup:
- `OMP_MOBILE_HOST` if set
- otherwise `tailscale ip -4` if available
- otherwise `127.0.0.1`

Port selection during setup:
- `OMP_MOBILE_PORT` if set
- otherwise `4317`

Common commands:

```bash
sudo systemctl status omp-mobile
sudo systemctl restart omp-mobile
journalctl -u omp-mobile -f
```

Reinstall the unit with different bind settings:

```bash
OMP_MOBILE_HOST=127.0.0.1 OMP_MOBILE_PORT=4317 ./setup.sh
```

---

## Local only

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`. No token needed on loopback.

---

## Remote access via Tailscale

Bind to your Tailscale IP (the `100.x.x.x` address from `tailscale ip -4`):

```bash
OMP_MOBILE_HOST=$(tailscale ip -4 | head -n1) ./setup.sh
sudo systemctl restart omp-mobile
```

Or run manually:

```bash
bun run dev -- --host 100.X.X.X --port 4317
```

Token auth is automatically disabled on tailnet addresses — you rely on tailnet ACLs instead.

### TLS with Tailscale certs

Place your Tailscale-issued cert and key in `.tls/` at the project root:

```
.tls/
  your-machine.ts.net.crt
  your-machine.ts.net.key
```

The server picks them up automatically when the host is a tailnet IP. You can then open `https://your-machine.ts.net:4317`.

---

## Remote access via Cloudflare Tunnel

Run a Cloudflare tunnel pointing to the local server:

```bash
bun run dev -- --port 4317
cloudflared tunnel --url http://127.0.0.1:4317
```

Cloudflare handles TLS termination. The server stays on loopback, so no token is required on the Bun side. Use Cloudflare Access policies to lock down who can reach the tunnel.

---

## Remote access via Tailscale + Cloudflare

If you want Cloudflare in front but the server only reachable over your tailnet:

```bash
bun run dev -- --host 100.X.X.X --port 4317
cloudflared tunnel --url http://100.X.X.X:4317
```

`cloudflared` must be running on a machine inside the same tailnet. Combine Cloudflare Access policies with tailnet ACLs for defense in depth.

---

## Token auth

When binding to a non-loopback, non-tailnet address, a token is required:

```bash
bun run dev -- --host 192.168.1.50 --port 4317 --token MY_SECRET
```

Pass it via query string (`?token=MY_SECRET`) or `Authorization: Bearer MY_SECRET` header.

You can also set it via environment variable:

```bash
OMP_MOBILE_TOKEN=MY_SECRET bun run dev -- --host 192.168.1.50 --port 4317
```

---

## Face ID (WebAuthn)

Face ID / Touch ID is optional. It is off by default and can be enabled by adding `?faceid=1` to the URL (the setting is remembered in localStorage).

When enabled, the server can require biometric enrollment and stores credentials in `~/.omp/agent/omp-mobile/faceid-credentials.json`.

Note: WebAuthn generally requires a hostname like `localhost` or a real domain; raw IPs (including Tailscale `100.x` addresses) may fail. Prefer MagicDNS hostnames like `https://your-machine.ts.net:4317`.

---

## Push notifications on iPhone

Install the app to the iPhone home screen, open it, and tap the new Notify button once to grant permission.
After that, assistant replies trigger push notifications through the service worker.

---

## Image upload

Use the new Add image button next to the composer to attach one or more images.
On iPhone, it opens the photo picker; on desktop, you can also paste screenshots into the page.

---

## Voice transcription (Parakeet)

`omp-mobile` expects a local Parakeet transcriber at:

- `/usr/local/bin/parakeet-transcribe`
- model dir `/usr/local/share/parakeet-tdt-0.6b-v3-int8`

Install dependencies:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --upgrade numpy onnxruntime
```

Model files expected in `/usr/local/share/parakeet-tdt-0.6b-v3-int8` are listed in `PARAKEET_MODEL_FILES.txt`.

Validation:

```bash
test -x /usr/local/bin/parakeet-transcribe && echo "ok: transcriber"
for f in $(cat PARAKEET_MODEL_FILES.txt); do test -f "/usr/local/share/parakeet-tdt-0.6b-v3-int8/$f" || echo "missing: $f"; done
```

---

## Tests

### Unit / golden (Bun snapshots)

```bash
bun test
```

Update snapshots:

```bash
bun test -u
```

### E2E (Playwright screenshots)

```bash
bun run test:e2e
```

Update screenshots:

```bash
bun run test:e2e -- --update-snapshots
```

### Replay fixtures (dev only)

E2E tests use deterministic replay from `public/fixtures/*.json`. Enable fixture serving:

```bash
OMP_MOBILE_REPLAY=1 bun run dev
```

Then open e.g. `http://localhost:4317/?replay=basic`.
