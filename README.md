# omp-mobile

Web UI for the OMP coding agent (mobile + desktop).

`omp-mobile` runs the agent on the host machine and lets you control sessions from browser clients (phone, tablet, laptop).

## What it supports

- Live session streaming (assistant text, reasoning, tools)
- Create/resume/release sessions
- Model + thinking controls
- Prompt images (upload/paste/camera picker)
- Ask-tool dialogs, commands list, mobile-friendly sidebar
- Optional push notifications
- Optional Face ID / Touch ID gate

Sessions are JSONL on disk, same location as the native `omp` CLI.

## Install

```bash
git clone https://github.com/basedcorp99/omp-mobile.git
cd omp-mobile
./setup.sh
```

The setup script:
- Installs the OMP package globally via npm if missing
- Installs bun dependencies for the web app itself
- Creates a `omp-mobile` launcher in `~/.bin` and adds it to PATH
- Installs a repo-owned systemd unit at `/etc/systemd/system/omp-mobile.service`
- Enables + starts the `omp-mobile` service
- Optionally installs voice transcription (Parakeet model, ~640MB)

`omp-mobile` is a standalone web app repo, not a plugin package to add to OMP settings.
At runtime, `omp-mobile` loads the system-installed OMP package from your global npm directory, so the web UI tracks the same OMP version as your `omp` CLI.
Slash commands and ask-tool prompts come from OMP/ACP; there are no legacy Pi plugin installs in this repo.

After setup:

```bash
omp-mobile                              # manual run
sudo systemctl restart omp-mobile       # managed service restart
journalctl -u omp-mobile -f             # live logs
```

By default, `./setup.sh` installs the systemd service using:
- `OMP_MOBILE_HOST` if set
- otherwise your Tailscale IPv4 if available
- otherwise `127.0.0.1`

You can override service bind settings during setup:

```bash
OMP_MOBILE_HOST=127.0.0.1 OMP_MOBILE_PORT=4317 ./setup.sh
```

See [RUNBOOK.md](./RUNBOOK.md) for systemd, Tailscale / Cloudflare / TLS / auth details.

## Prerequisites

- [bun](https://bun.sh) runtime
- Node.js / npm (used by `./setup.sh` to install the global OMP package)
- OMP coding agent if you are installing manually without `./setup.sh`

Optional (for voice input):
- python3, numpy, onnxruntime
- ffmpeg

---

## Voice transcription (Parakeet)

Voice is optional — if not installed, the mic button is disabled and the server returns "Parakeet not available".

The easiest way to set it up is `./setup.sh --all`. It installs everything to user directories (`~/.bin`, `~/.local/share`) — no sudo required.

### Manual setup

<details>
<summary>Click to expand manual voice setup</summary>

#### 1) Install runtime deps

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --upgrade numpy onnxruntime
```

#### 2) Install transcriber script

The script is included in the repo as `parakeet-transcribe`. Copy it somewhere in PATH:

```bash
cp parakeet-transcribe ~/.bin/
chmod +x ~/.bin/parakeet-transcribe
```

omp-mobile checks these locations (first match wins):
- `~/.bin/parakeet-transcribe`
- `/usr/local/bin/parakeet-transcribe`

#### 3) Download model files

```bash
curl -L https://blob.handy.computer/parakeet-v3-int8.tar.gz -o /tmp/parakeet-v3-int8.tar.gz
mkdir -p ~/.local/share
tar -xzf /tmp/parakeet-v3-int8.tar.gz -C ~/.local/share
rm /tmp/parakeet-v3-int8.tar.gz
```

omp-mobile checks these locations (first match wins):
- `~/.local/share/parakeet-tdt-0.6b-v3-int8`
- `/usr/local/share/parakeet-tdt-0.6b-v3-int8`

Required files are listed in [`PARAKEET_MODEL_FILES.txt`](./PARAKEET_MODEL_FILES.txt).

#### 4) Health check

```bash
test -x ~/.bin/parakeet-transcribe && echo "ok: script"
for f in $(cat PARAKEET_MODEL_FILES.txt); do
  test -f ~/.local/share/parakeet-tdt-0.6b-v3-int8/$f || echo "missing: $f"
done
```

</details>

---

## Data locations

| What | Path |
|------|------|
| OMP sessions (JSONL) | OMP's native session directory |
| Saved repos | `~/.omp/agent/omp-mobile/repos.json` |
| Archived sessions | `~/.omp/agent/omp-mobile/archive.json` |
| Push subscriptions | `~/.omp/agent/omp-mobile/push.json` |
| Face ID credentials | `~/.omp/agent/omp-mobile/faceid-credentials.json` |

The rename moves app-owned metadata out of the old `~/.pi/agent/pi-web` directory. Existing files there are read as a fallback and written forward to the new location when touched. Existing OMP session history is still owned by OMP itself.

## Session semantics

- **Abort**: stops current run, keeps runtime alive.
- **Release**: aborts and disposes runtime so you can safely resume the same JSONL in native `omp`.

Do not open the same session in `omp-mobile` and native `omp` at the same time.

## Credits

Built on top of OMP (`@oh-my-pi/pi-coding-agent`).
