// ECC Memory Vault MCP wrapper
// Resolves the ecc-universal package dynamically so the config works across
// Node version managers (fnm, nvm, etc.) whose global paths change per shell.
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';

let globalRoot;
try {
  globalRoot = execSync('npm root -g', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
} catch (err) {
  console.error('Failed to resolve global npm root:', err.message);
  process.exit(1);
}

const scriptPath = `${globalRoot}/ecc-universal/scripts/memory-mcp.mjs`;

const child = spawn(process.execPath, [scriptPath], {
  stdio: 'inherit',
});

child.on('error', (err) => {
  console.error('Failed to start ECC memory vault:', err.message);
  process.exit(1);
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
