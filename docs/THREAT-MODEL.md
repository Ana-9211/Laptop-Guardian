# Threat model (one page)

Laptop Guardian is a local tool that can change things on a Windows laptop (stop a program, disable a task, recycle a file, change a firewall rule, ask for
administrator rights). So the question is who else could make it do those things, and what stops them. Everything below is checked by tests named in
`docs/history/BUILD-LOG-*.md` unless it says otherwise. See `docs/ARCHITECTURE.md` for the parts.

## What is being protected

* The laptop's files, programs and settings from being changed by something that is not the user.
* The user's trust in the app: nothing runs that the user did not see and confirm, and what the app reports is what happened.
* The administrator boundary: nothing may gain administrator rights through Guardian's scheduled tasks or its one elevated helper.

## The bridge (the local web server) defends against

| Threat | Defence |
|---|---|
| A web page in the user's browser calls the local API (CSRF) | Every change needs a custom `X-Guardian` header and a same-origin `Origin` that matches the bridge's own host and port; requests labelled cross-site by the browser (`Sec-Fetch-Site`) are refused; there is no CORS. |
| DNS rebinding (a hostile site resolves its name to 127.0.0.1) | The `Host` header must be exactly `127.0.0.1:<port>` or `localhost:<port>`; anything else is refused before routing. The server listens on 127.0.0.1 only. |
| Another program or user on the laptop calls the API | Every `/api` call except the version ping needs a per-start random Bearer token, compared in constant time. The token is in `data/state/bridge.json` (limited to the current user) and reaches the page in the URL fragment (never sent to a server, kept in `sessionStorage`). |
| Something that is not a button press runs a command | The bridge has no way to run text. It starts a fixed list of scripts, with arguments bound to typed parameters. Every fix is an entry in the closed list `src/shared/action-catalog.json`; parameters are checked against fixed patterns in Node and again in PowerShell; a plan token is single use and expires; protected processes, services and paths are refused in both languages (and a test keeps the two lists identical). |
| AI output tries to act | Gemini only receives structured metadata and only returns explanations. Its output is validated against a schema and can never add or change an action. |
| A page or response is used to attack the dashboard | `Content-Security-Policy`, `X-Content-Type-Options`, `Cross-Origin-Resource-Policy`/`-Opener-Policy`; reports are served in a sandboxed frame; request bodies are size-capped; at most three PowerShell children run at once. |
| Two writers corrupt a shared file | Shared files use one lock protocol (bridge and agents) that fails closed, never takes a live owner's lock, and is tested with concurrent writers. |

## The elevation boundary protects

* **Administrator tasks run only from a trusted install.** Daily and Weekly with highest privileges, and the single elevated action helper, refuse to start unless
  the program folder and everything it runs from can be changed only by SYSTEM, Administrators and TrustedInstaller (an installed copy under Program
  Files). A development checkout is refused for administrator work. There is no flag or environment variable that overrides this.
* **Results and audit lines of administrator runs** live in an administrators-only `%ProgramData%\LaptopGuardian` folder whose permissions the installer sets
  and reads back.
* **The user-editable files are untrusted when elevated.** `config.json`, the policy files and the ignore list are clamped (numbers to fixed ranges, switches
  coerced, drive letters validated, no path from them is ever a delete target, ignore entries must be plain ids), and a name-only blacklist entry never ends a
  program in an elevated run (it needs the exact executable path).
* **Lookalike names do not borrow trust.** A process named like a Windows process but running from somewhere else is not protected by its name: it is labelled
  suspicious, needs an explicit acknowledgement to be stopped, and is never ended automatically. Signed Windows files get trust from their location and
  signature, not their name.
* **Third-party tools are checked, not assumed.** Revo Uninstaller is used only when its signature is valid, the signer name matches exactly and its
  certificate thumbprint is on a short list kept in the code.

## Out of scope (Guardian does not claim to stop these)

* **Malware already running as an administrator**, or any code running as the same user that reads the session token and then also persuades the user to
  confirm an action. A same-user program can use the local API as the user can; UAC remains the gate for anything that needs administrator rights.
* **A compromised Node.js, PowerShell, Windows or browser.** The app trusts the runtimes it starts.
* **Physical access** to the unlocked laptop, or to the disk (the Gemini key is protected by Windows DPAPI for the user account, not against that account).
* **Kernel-level packet filtering or inspection.** Windows Firewall is the enforcement engine; Guardian audits it and manages only its own `LG-` rules. It does
  not capture packets, and a program that uses its own encrypted DNS bypasses hosts-file blocking.
* **Supply chain** beyond what `npm audit` and the lockfiles show: the dashboard's build tools are development dependencies, and the shipped bridge has none.
* Anything that was not tested on a real Windows install with real administrator rights yet: see "Still open" in `docs/history/BUILD-LOG-3.md` and
  `docs/history/BUILD-LOG-4.md`.
