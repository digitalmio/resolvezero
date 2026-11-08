# ResolveZero Agent (Rust)

The ResolveZero local DNS-to-DoH agent. It listens on UDP/TCP 53, forwards to
the edge over DoH, and ships as a single static Rust binary with no JavaScript
runtime. It is part of the Cargo workspace and CI.

```text
LAN devices → UDP/TCP 53 → resolvezero-agent → DoH → ResolveZero edge
```

## Behavior

| Behaviour | Supported |
|---|---|
| UDP + TCP listeners on `DNS_PORT` | ✅ |
| RFC 1035 TCP framing (2-byte length) | ✅ |
| DoH `POST /v1/:profile/:device/:token` | ✅ |
| `DEVICE_MAP` label → device slug | ✅ |
| IP-derived slug fallback | ✅ |
| EDNS UDP payload clamp (512–4096) | ✅ |
| TC response when the answer is too big | ✅ |
| SERVFAIL on upstream error | ✅ |
| SERVFAIL on transaction-ID mismatch | ✅ |
| Optional `/healthz` + `/readyz` | ✅ |
| Stateless (no cache, no filtering) | ✅ |
| `.lan` / `.home.arpa` forwarded to the edge | ✅ |
| JSON-line logs | ✅ |
| SIGINT/SIGTERM shutdown | ✅ |

Notes:

- DNS header/question handling uses `hickory-proto`.
- TCP responses are written through a per-connection channel; ordering can be
  out-of-order under pipelining.
- Log timestamps are RFC 3339 with nanoseconds.

## Build

```sh
cargo build --release -p resolvezero-agent --bin resolvezero-agent
# target/release/resolvezero-agent
```

Static-ish Linux builds (musl) if you want a single file without glibc:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release -p resolvezero-agent --bin resolvezero-agent --target x86_64-unknown-linux-musl
```

## Prebuilt binaries

Pushing an `agent-v*` tag runs `.github/workflows/release-agent.yml` and
publishes a static Linux x86_64 musl binary plus a SHA-256 file:

```sh
curl -L -o resolvezero-agent \
  https://github.com/digitalmio/resolvezero/releases/latest/download/resolvezero-agent-linux-x86_64
curl -L -o resolvezero-agent.sha256 \
  https://github.com/digitalmio/resolvezero/releases/latest/download/resolvezero-agent-linux-x86_64.sha256
sha256sum -c resolvezero-agent.sha256
sudo install -m 0755 resolvezero-agent /usr/local/bin/resolvezero-agent
```

The systemd unit is in `deploy/resolvezero-agent.service`; put the profile
credentials in `/etc/resolvezero-agent.env`:

```sh
PROFILE_ID=...
DOH_TOKEN=...
DOH_URL=https://resolvezero-edge.fly.dev
DEVICE_MAP=192.168.1.50=nas
```

## Run

```sh
PROFILE_ID=... DOH_TOKEN=... DNS_PORT=5353 cargo run -p resolvezero-agent --bin resolvezero-agent
```

Port 53 is privileged. On Linux either run as root, grant
`CAP_NET_BIND_SERVICE`, or use Docker with host networking. Do not expose the
agent directly to the internet.

## Configuration

Environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROFILE_ID` (or `RESOLVEZERO_PROFILE_ID`) | yes | — | ResolveZero profile id |
| `DOH_TOKEN` (or `RESOLVEZERO_DOH_TOKEN`) | yes | — | DoH token for that profile |
| `DOH_URL` | no | `https://resolvezero-edge.fly.dev` | Edge base URL |
| `BIND_HOST` | no | `0.0.0.0` | DNS listen address |
| `DNS_PORT` | no | `53` | DNS port |
| `DOH_TIMEOUT_MS` | no | `5000` | Upstream timeout |
| `DEVICE_MAP` | no | empty | `ip=label` entries, comma/`;`/newline separated |
| `HEALTH_PORT` | no | `0` (off) | Localhost health/readiness port |
| `HEALTH_HOST` | no | `127.0.0.1` | Health listen address |

`DEVICE_MAP="192.168.1.20=macbook,192.168.1.21=iphone"` — labels are slugified
(`MacBook Pro` → `macbook-pro`), falling back to `ip-<addr>`.

## Test

```sh
cargo test
```

23 tests cover config parsing/slugging, EDNS clamp, SERVFAIL/TC construction,
transaction-ID checks, DoH request shaping (against a local HTTP server), UDP +
TCP end-to-end with an injected resolver, truncation, and the health endpoint.

## Docker

```sh
docker build -t resolvezero-agent .
docker run -d --name resolvezero-agent \
  --network host \
  --cap-add NET_BIND_SERVICE \
  --env-file .env \
  --restart unless-stopped \
  resolvezero-agent
```

## systemd

See `deploy/resolvezero-agent.service`:

```sh
sudo install -m 0755 target/release/resolvezero-agent /usr/local/bin/resolvezero-agent
sudo install -m 0600 .env /etc/resolvezero-agent.env
sudo install -m 0644 deploy/resolvezero-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now resolvezero-agent
```

## Not in this MVP

- DHCP
- local filtering
- local cache
- mDNS/PTR hostname discovery
- DoT/DoQ listener
- auto-update
- Windows service packaging
- router packages
