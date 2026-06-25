# UK Egress & Residential-Proxy Strategy

> Scope: how the interactive **§6a "live link resolution (Claude-in-Chrome)"** pass obtains a UK exit IP, and the fallback for when a UK exit is blocked by exit-IP reputation rather than geography.
> Status: operations reference. Last updated: 2026-06-25.

## Why a UK exit IP is needed

The §6a Chrome pass loads UK job-board / ATS / recruiter pages to confirm a role is live and meets the screening gates. Some UK boards geo-restrict and will reject or mis-serve requests from a non-UK IP (a region block reads as *"candidates from your area are not accepted"*). The pass therefore needs to **egress from a UK IP**.

Two situations make the runner's default IP non-UK:

1. **Occasional travel** outside the UK while running the pass.
2. **Future automation** — the planned move of the daily scan to a cloud VM (Terraform-provisioned, headless), whose **datacenter IP** boards may geo-block regardless of the VM's region.

## Near-term solution: consumer VPN (UI-driven)

Current approach: a paid consumer VPN app (Total VPN) connected to a **UK** server before the pass and disconnected after.

- It is **not** controllable by macOS system tools. Verified 2026-06-25: `scutil --nc list` does not list it (it runs its tunnel inside its own app process, even with the IPSec protocol selected), so `scutil` / `networksetup` / `vpnutil` cannot start/stop it, and it ships **no CLI**. → It is **GUI-only**: connect/disconnect by clicking the app (the agent can do this via desktop control during an interactive pass).
- Adequate for most pages — ATS / recruiter sites rarely geo-block.

## The blocking problem (why a "better VPN" is not the answer)

Geo-rejects can still occur **with** a UK VPN, because the block is by **exit-IP reputation**, not geography. Cloudflare and large job boards score **datacenter and known-VPN IP ranges** as low-trust and may challenge or reject them on sight; **residential ISP IPs** score well. Every commercial VPN and every cloud VM exits from a datacenter IP, so swapping VPN tool does not reliably fix blocking. The only reliably-unblocked UK egress is a **UK residential IP**.

## Block-resistant fallback: UK residential proxy

A residential proxy is a **browser/app-level HTTP(S) (or SOCKS5) proxy** — *not* a system VPN — whose exit is a real UK home IP. It is scoped to just the page fetches that need it, leaving all other traffic direct.

**Safety notes**

- **Customer ≠ exit node.** Paying to *use* a residential proxy does **not** turn the runner's own machine into an exit node for others. A machine only becomes an exit by installing a bandwidth-sharing app or a free app/VPN that bundles such an SDK (e.g. the historical HolaVPN → Luminati case). So buying proxy access is safe; **do not install "free VPN" or "earn by sharing your internet" apps**.
- Prefer providers with transparent, consent-based (opt-in) sourcing and recognised certifications; avoid "free residential proxies" (typically malware / botnet-sourced).

**Provider shortlist** (pay-as-you-go, UK, low volume)

| Provider | $/GB (PAYG) | Traffic expiry | To start | Pool / sourcing |
|---|---|---|---|---|
| **DataImpulse** (chosen) | $1 | Non-expiring | $5 min deposit | ~90M IPs; ISO 27001; first-party opt-in app + SDK |
| Decodo (ex-Smartproxy) | $4 | verify | free 100 MB trial | 125M IPs (5M UK); opt-in sourcing |
| IPRoyal | $7 | Non-expiring | day pass | larger pool; documented Pawns.app opt-in sourcing |

A Chrome pass is a handful of page-loads (~tens of MB), so the per-run cost is pennies; a single GB covers dozens–hundreds of passes.

**Wiring (browser)**

- Use the **Proxy SwitchyOmega** extension (it handles `user:pass` auth that raw Chrome cannot). Create an HTTP profile pointing at the provider's **UK endpoint** (`host:port`) with the supplied credentials; toggle it **on** before the pass and **off** after.
- **Credential boundary:** the **operator** signs up, funds the account, and supplies the endpoint credentials. The agent only configures the browser profile and toggles it — it does not create accounts or enter payment / credentials.

**Trigger**

Reach for the residential proxy when a board **geo-rejects during the §6a Chrome pass and reconnecting the UK VPN does not clear it**. Until then, the consumer-VPN (UI) path remains the default.

## Long-term direction

When the daily scan moves to a Terraform-provisioned cloud VM (headless), the "agent can only click, not type" constraint disappears and CLI options become usable:

- A UK-region VM provides a UK IP for free (no VPN needed for geolocation), but it is a **datacenter** IP and still blockable.
- For boards that block datacenter IPs, route those fetches through the **UK residential proxy** (HTTP-proxy env / SOCKS5) — the same fallback, now headless and scriptable.
- A CLI VPN (self-hosted WireGuard, Mullvad CLI, Windscribe's Linux CLI, etc.) is optional and only adds another blockable datacenter hop.
