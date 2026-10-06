# Laptop Guardian: architecture

A map of where things live and how a request travels. For the data files and the HTTP API see `DATA-CONTRACT.md`; for what the product does see `README.md`.

## Three programs that talk through files and one local API

| Part | Where | Job |
|---|---|---|
| PowerShell agents | `src/powershell` | Observe (processes, storage, Defender, health, network), write reports and `data/latest/*.json`, run the fixed actions. Started by Task Scheduler (Daily, Weekly) or by the bridge. |
| Bridge | `src/bridge` | Node, no dependencies. Binds 127.0.0.1, serves the dashboard and a JSON API, starts PowerShell scripts from a fixed list, never builds a command from input. |
| Dashboard | `src/dashboard/src` | React + TypeScript, built to `src/dashboard/dist` and served by the bridge. |

The action catalog `src/shared/action-catalog.json` is read by both sides. It is the only list of things Guardian can do.

## Folders at run time

| Folder | Installed copy | Development checkout |
|---|---|---|
| Program files | `%ProgramFiles%\LaptopGuardian` (administrators only) | the checkout |
| Your data (config, data, reports, logs) | `%LOCALAPPDATA%\LaptopGuardian` | the checkout |
| Administrator results and audit lines | `%ProgramData%\LaptopGuardian` (administrators only) | not used; administrator work is refused |
| Default port | 7878 | 7879 |

`install.json` beside the program files marks an installed copy and names the other two folders. `Get-GuardianDataRoot`, `Get-GuardianCodeRoot` (PowerShell) and `U.readInstall` (bridge) read it; the environment cannot redirect an installed copy.

## PowerShell (`src/powershell`)

`Common\Load.ps1` is dot-sourced by every entry script. It sets UTF-8 on stdout/stdin first (`Common\Encoding.ps1`) and imports the modules.

| Folder | Contents |
|---|---|
| `Common` | `Core` (roots, config, logging, locks, JSON), `Security` (protected lists, image trust), `Encoding.ps1`, `Load.ps1` |
| `Install` | `InstallSecurity` (trust check, ACLs, config clamping), `Installer` (copy, migration, rollback, plan) |
| `Processes`, `Storage`, `Defender`, `Health`, `Files`, `Network`, `Services`, `Windows`, `Shutdown` | Observers and their report sections |
| `Pipeline`, `Reports`, `AI` | Run orchestration, report writing, optional Gemini analysis |
| `Actions` | `Remediation.psm1` and `NetworkActions.psm1` plus their family files, `RemHelpers`, and the three entry scripts (`Invoke-GuardianAction`, `Request-ElevatedAction`, `Get-RemediationInfo`) |
| `Launcher` | Start the bridge, open the app window, shortcuts |
| `Daily.ps1`, `Weekly.ps1`, `Scheduler.ps1`, `Start-Dashboard.ps1` | Entry points |

**Action families.** `Actions\Remediation.psm1` and `Actions\NetworkActions.psm1` hold the module header and the export list. Each family is a file under `Actions\Remediation\` or `Actions\NetworkActions\` (Catalog, Helpers, Apps, Processes, Startup, Tasks, Services, Files, Defender, Firewall, Dns, Dispatch; Wrappers, Targets, Registry, Firewall, DnsBlock, DnsLog) that the module dot-sources. They are one module scope on purpose: Pester mocks (`-ModuleName Remediation`) and the public exports are unchanged. To add an action: catalog entry, a `Test-` and an `Invoke-` function in the right family file, a row in `Dispatch.ps1`.

**Trust boundary.** Elevated runs call `Assert-ElevatedCodeTrusted` and refuse unless the folder they run from can be changed only by administrators. Elevated code treats `config.json`, the policy files and the ignore list as untrusted (`Limit-ConfigForElevation`, `Get-SafeIgnoredIds`).

## Bridge (`src/bridge`)

```
server.js            wires the pieces and starts listening (thin)
lib/context.js       shared state: paths, config/policy readers, audit log, Task Scheduler cache, token, route table
lib/network-context.js   Network Guard store, Deep Network Guard, snapshots, views
lib/http.js          HttpError, security headers, JSON body, static files, the request pipeline
lib/constants.js     shared numbers and patterns
routes/*.js          one file per area: status, reports, files, settings, ai, schedule, network, remediation
lib/status.js ...    pure helpers (attention items, findings, remediation planner, util, protected lists, ps runner)
```

A request passes in this order (`lib/http.js`): Host allowlist, cross-site refusal, session token, `X-Guardian` header and same-origin `Origin` on mutations, route match, handler, response. Routes are registered in a fixed order and the first match wins. A route module is `function (ctx) { const { ... } = ctx; route('GET', '/api/...', handler) }`.

To add an endpoint: put it in the route file of its area, take what it needs from `ctx`, add a test in `tests/`.

## Dashboard (`src/dashboard/src`)

```
App.tsx, router.ts, nav.ts      shell, hash router (one listener), navigation list
api.ts                          fetch wrapper, session token, GET coalescing, useQuery
state/                          overview, findings and remediation history (shared queries), status polling, connection, background actions
pages/                          one file per page
components/ui/                  shared building blocks, grouped (icons, display, controls, feedback, overlay, actions, table); components/ui/index.tsx is the barrel
components/settings/            the Settings cards
components/network/             the Network Guard panels (NetworkParts.tsx re-exports them)
components/ActionFlow.tsx       plan -> confirm -> execute -> verify flow used by every fix button
```

Pages that need the same data read it from a shared context (`useOverview`, `useFindings`, `useRemediationHistory`) rather than fetching it again.

## Tests

| Suite | Command | Covers |
|---|---|---|
| Node | `npm run check` | bridge, status logic, catalog parity, encoding, ASCII check |
| Pester (one file per process) | `powershell -File tests/Run-Tests.ps1 [-Integration]` | agents, actions, install, security |
| Lint | `npm run lint:ps` | PSScriptAnalyzer |
| Browser | `node tests/browser/smoke.mjs [--real]` | the dashboard in Edge, fixture data or read-only against this install |
