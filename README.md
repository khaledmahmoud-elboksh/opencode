# OpenCode Harness Config

Portable configuration for the OpenCode harness: agents, custom commands, plugins, MCP servers, and memory. Clone this repo on any machine to reproduce the full setup.

## What's inside

| Path | Purpose |
|---|---|
| `opencode.json` | MCP servers (context7, playwright, github, sequential-thinking, chrome-devtools, ECC memory vault) + npm plugins |
| `agents/` | Custom subagents: superagent router, build-fixer, verifier, planner, security-reviewer, etc. |
| `commands/` | Custom slash commands: commit-push, review-pr, memory, knowledge, task-board, etc. |
| `command/` | Legacy command dir (superagent openai) |
| `plugins/` | Local plugins: autotitle, dodopayments, hooks, notify |
| `AGENTS.md` | Global instructions every session loads |
| `memory/` | Harness memory blocks (persona, human preferences) |
| `cli.json` | TUI preferences (theme, scrollbars, animations) |
| `install.ps1` | One-time setup script for a new machine |

**Never committed:** `service.json` (local auth password, auto-regenerated), `node_modules/`, lockfiles (OpenCode restores deps from the `plugins` array on startup).

## New machine setup (Windows)

1. **Prerequisites**
   ```powershell
   winget install Git.Git OpenJS.NodeJS.LTS GitHub.cli
   npm install -g opencode-ai
   ```
   (GitHub CLI optional — only needed to push changes back.)

2. **Clone into the config location**
   ```powershell
   git clone https://github.com/<YOUR_USER>/opencode-config.git "$env:USERPROFILE\.config\opencode"
   ```

3. **Run the setup script** (installs `ecc-universal`, patches machine-specific paths, checks tools)
   ```powershell
   cd "$env:USERPROFILE\.config\opencode"
   .\install.ps1
   ```

4. **Set the GitHub token** (used by the `github` MCP server)
   ```powershell
   setx GITHUB_TOKEN "<your-personal-access-token>"
   ```
   Create a token at https://github.com/settings/tokens if you don't have one.

5. **Login where needed**
   - `gh auth login` (GitHub CLI)
   - Start `opencode` — it handles its own provider/model auth on first run.

6. **Verify**
   ```powershell
   opencode
   ```
   Then check that MCP servers connect and custom commands appear.

## Keeping machines in sync

- **Push changes from any machine:**
  ```powershell
  cd "$env:USERPROFILE\.config\opencode"
  git add -A ; git commit -m "update config" ; git push
  ```
- **Pull on other machines:** `git pull` in the config dir, then restart OpenCode.

> Note: `install.ps1` rewrites the ECC memory path in `opencode.json` to match the local machine. If `git pull` shows `opencode.json` as modified after running it, that's expected — commit it or leave it, the script re-patches every run.

## Adding a new laptop in 30 seconds

```powershell
winget install Git.Git OpenJS.NodeJS.LTS; npm install -g opencode-ai
git clone https://github.com/<YOUR_USER>/opencode-config.git "$env:USERPROFILE\.config\opencode"
cd "$env:USERPROFILE\.config\opencode"; .\install.ps1; setx GITHUB_TOKEN "<token>"; opencode
```
