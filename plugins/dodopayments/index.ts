// Ported from @dodopayments/opencode-plugin (V1) to the OpenCode V2 plugin API.
//
// The V1 package registered the Dodo Payments MCP server through the legacy
// `config` hook, which no longer runs on OpenCode 2.x. This local port keeps
// the same behavior: register the server unless the user already declared an
// MCP entry with the same key (user config wins), and honor the
// DODO_DISABLE_API_MCP env flag.
//
// The endpoint URL below must match the canonical mcp.json from
// @dodopayments/opencode-plugin. `type: "remote"` is OpenCode's native
// Streamable HTTP transport; OpenCode runs OAuth discovery itself when the
// connection returns 401 (sign in via /mcps -> dodopayments).
const DODO_MCP_SERVERS: Record<string, { type: "remote"; url: string }> = {
  dodopayments: {
    type: "remote",
    url: "https://mcp.dodopayments.com/mcp",
  },
};

const DISABLE_FLAGS: Record<string, string> = {
  dodopayments: "DODO_DISABLE_API_MCP",
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

function isDisabled(envVarName: string): boolean {
  const raw = process.env[envVarName];
  if (raw === undefined || raw === null || raw === "") return false;
  return TRUTHY.has(String(raw).trim().toLowerCase());
}

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "dodopayments",
  async setup(ctx) {
    await ctx.mcp.transform((editor) => {
      for (const [name, entry] of Object.entries(DODO_MCP_SERVERS)) {
        if (isDisabled(DISABLE_FLAGS[name] ?? "")) continue;
        // Nullish semantics preserved from the V1 hook: a server declared in the
        // user's own opencode.json (or a previous transform) is never replaced.
        if (!editor.get(name)) {
          editor.set(name, entry);
        }
      }
    });
  },
});
