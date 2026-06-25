# UK Egress & Residential-Proxy Strategy

> **Status: forward-strategy & owner playbook — NOT a change to the live §6a Chrome-pass contract.** The live screening rule is unchanged: a geo-reject during the §6a pass = **VPN-not-connected** → pause and re-remind the owner, never record the role as a dead listing (instructions §6a). This doc covers the UK-egress *options* and the **future, owner-activated** residential-proxy fallback (not yet built).
> Scope: how the interactive **§6a "live link resolution (Claude-in-Chrome)"** pass obtains a UK exit IP, and the fallback for when a UK exit is blocked by exit-IP reputation rather than geography.
> Last updated: 2026-06-25.

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

Geo-rejects can still occur **with** a UK VPN, because the block is by **exit-IP reputation**, not geography. Cloudflare and large job boards score **datacenter and known-VPN IP ranges** as low-trust and may challenge or reject them on sight; **residential ISP IPs** score well. Mainstream consumer-VPN endpoints and cloud VMs exit from datacenter (or known-VPN) IPs, so swapping VPN tool does not reliably fix blocking. The only reliably-unblocked UK egress is a **UK residential IP**.

## Block-resistant fallback: UK residential proxy

A residential proxy is a **browser/app-level HTTP(S) (or SOCKS5) proxy** — *not* a system VPN — whose exit is a real UK home IP. It is scoped to just the page fetches that need it, leaving all other traffic direct.

**Safety notes**

- **Customer ≠ exit node.** Paying to *use* a residential proxy does **not** turn the runner's own machine into an exit node for others. A machine only becomes an exit by installing a bandwidth-sharing app or a free app/VPN that bundles such an SDK (e.g. the historical HolaVPN → Luminati case). So buying proxy access is safe; **do not install "free VPN" or "earn by sharing your internet" apps**.
- Prefer providers with transparent, consent-based (opt-in) sourcing and recognised certifications; avoid "free residential proxies" (typically malware / botnet-sourced).

**Provider shortlist** (pay-as-you-go, UK, low volume). Costs and pool sizes are **relative ordering only** — **check the provider's current pricing / pool page before purchase**:

| Provider | Relative cost (PAYG) | Notes |
|---|---|---|
| **DataImpulse** (chosen) | Cheapest | Non-expiring traffic; low minimum deposit; ISO 27001; first-party opt-in app + SDK |
| Decodo (ex-Smartproxy) | Mid-price | Free trial to test before buying; opt-in sourcing |
| IPRoyal | Priciest | Non-expiring traffic; most-transparent sourcing (documented Pawns.app opt-in) |

A Chrome pass is a handful of page-loads (~tens of MB), so the per-run cost is pennies; a single GB covers dozens–hundreds of passes.

**Wiring (browser)**

- Use the **Proxy SwitchyOmega** extension (it handles `user:pass` auth that raw Chrome cannot). Create an HTTP profile pointing at the provider's **UK endpoint** (`host:port`) with the supplied credentials; toggle it **on** before the pass and **off** after.
- **Credential boundary:** the **operator** signs up, funds the account, and supplies the endpoint credentials. The agent only configures the browser profile and toggles it — it does not create accounts or enter payment / credentials.

**Trigger (owner action — not a live agent step)**

The live §6a rule is unchanged: a geo-reject = treat as **VPN-not-connected**, pause and re-remind, never record the role as dead. This proxy path is **not yet built and is not an autonomous escalation**. A *pattern* of geo-rejects that **persist after reconnecting the UK VPN** is the signal for the **owner** to stand the proxy up: sign up, fund the account, and supply the endpoint credentials (the agent then wires Proxy SwitchyOmega per *Wiring* above). Until the owner activates it, the consumer-VPN (UI) path is the **only** egress.

## Long-term direction

When the daily scan moves to a Terraform-provisioned cloud VM (headless), the "agent can only click, not type" constraint disappears and CLI options become usable:

- A UK-region VM provides a UK IP for free (no VPN needed for geolocation), but it is a **datacenter** IP and still blockable.
- For boards that block datacenter IPs, route those fetches through the **UK residential proxy** (HTTP-proxy env / SOCKS5) — the same fallback, now headless and scriptable.
- A CLI VPN (self-hosted WireGuard, Mullvad CLI, Windscribe's Linux CLI, etc.) is optional and only adds another blockable datacenter hop.
