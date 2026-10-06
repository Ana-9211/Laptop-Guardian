# Laptop Guardian

Laptop Guardian is a Windows laptop audit and maintenance tool that I am building while learning more about systems and security.

It collects information about a machine, explains what it finds, and presents the results in a local dashboard. The project is still being developed, so it is not a production-finished security product.

## What it includes

- PowerShell agents for daily and weekly system checks
- A local React dashboard served by a small Node bridge
- Process, storage, Defender, Windows health, and network visibility
- An Action Center for confirmed and verified remediation
- Network Guard for local connection visibility and Guardian-owned firewall rules
- Optional AI-assisted explanations, kept separate from deterministic checks

## Safety principles

- The dashboard is local-only and binds to `127.0.0.1`.
- Safe Mode is enabled by default.
- AI output cannot execute commands.
- Remediation requires confirmation and is verified afterward.
- Guardian manages only the firewall rules it creates.
- Automated tests do not perform destructive system actions.

## Development status

The first architecture, stabilization, Action Center, and Network Guard milestones are in the Git history. I am continuing to improve the implementation, tests, installation layout, and dashboard experience.

## Running it locally

This project targets Windows 10/11, Windows PowerShell 5.1, and Node.js 22.18 or newer.

```powershell
npm ci
npm run check
npm run test:ps
npm run build
```

The installer and dashboard launcher are documented in the source tree. Read the safety settings before enabling automated actions.

## License

MIT. See [LICENSE](LICENSE).

## About the project

This is my project. I designed it, planned it, wrote the code, tested it, and made the engineering decisions. I use coding tools to help rewrite or refactor work after I have tested and reviewed it; they do not represent the authorship or direction of the project.
