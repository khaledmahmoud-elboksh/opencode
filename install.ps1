# install.ps1 -- one-time setup after cloning this repo on a new machine.
# Run from inside the cloned config dir:
#   cd $env:USERPROFILE\.config\opencode
#   .\install.ps1

$ErrorActionPreference = "Stop"
Write-Host "== OpenCode harness setup ==" -ForegroundColor Cyan

# --- 1. Check prerequisites -------------------------------------------------
$missing = @()
foreach ($tool in @("git", "node", "npm", "opencode")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { $missing += $tool }
}
if ($missing) {
    Write-Warning "Missing tools: $($missing -join ', ')"
    Write-Host "Install hints:" -ForegroundColor Yellow
    Write-Host "  git      : winget install Git.Git"
    Write-Host "  node/npm : winget install OpenJS.NodeJS.LTS"
    Write-Host "  opencode : npm install -g opencode-ai"
    if ($missing -contains "opencode") {
        Write-Host "opencode is required to finish; install it, reopen the terminal, re-run this script." -ForegroundColor Yellow
        exit 1
    }
    Write-Warning "Continuing without: $(($missing | Where-Object { $_ -ne 'opencode' }) -join ', ')"
}

# --- 2. ECC memory MCP (global npm package) ---------------------------------
$eccRoot = Join-Path (npm root -g) "ecc-universal\scripts\memory-mcp.mjs"
if (-not (Test-Path $eccRoot)) {
    Write-Host "Installing ecc-universal globally..."
    npm install -g ecc-universal
}
if (-not (Test-Path $eccRoot)) {
    Write-Warning "ecc-universal still not found at $eccRoot -- check npm global prefix."
    exit 1
}

# --- 3. Patch the machine-specific wrapper path in opencode.json ------------
$wrapperPath = Join-Path $PSScriptRoot "mcp-memory-vault.mjs"
if (-not (Test-Path $wrapperPath)) {
    Write-Warning "Wrapper script not found: $wrapperPath"
    exit 1
}

$configPath = Join-Path $PSScriptRoot "opencode.json"
$config = Get-Content $configPath -Raw
$pattern = '"node",\s*"[^"]*mcp-memory-vault\.mjs"'
$replacement = '"node", "' + ($wrapperPath -replace '\\', '\\\\') + '"'
if ($config -match $pattern) {
    $config = $config -replace $pattern, $replacement
    Set-Content $configPath $config -Encoding UTF8
    Write-Host "Patched ecc-memory-vault wrapper path -> $wrapperPath" -ForegroundColor Green
}
else {
    Write-Host "ecc-memory-vault wrapper path already correct." -ForegroundColor DarkGray
}

# --- 4. Environment variables the config expects ----------------------------
if (-not $env:GITHUB_TOKEN) {
    Write-Warning "GITHUB_TOKEN is not set. The 'github' MCP server needs it."
    Write-Host '  setx GITHUB_TOKEN "<your-personal-access-token>"  (then reopen the terminal)' -ForegroundColor Yellow
    Write-Host "  Create one at: https://github.com/settings/tokens"
}

# --- 5. Done ----------------------------------------------------------------
Write-Host ""
Write-Host "Setup complete. Start OpenCode to verify:" -ForegroundColor Green
Write-Host "  opencode"
