// SPDX-License-Identifier: MIT
//
// @metaharness/host-codex — OpenAI Codex CLI host adapter.
//
// Verified integration surface (from research):
//   - Repo: https://github.com/openai/codex
//   - Docs: https://developers.openai.com/codex/config-basic
//           https://developers.openai.com/codex/mcp
//   - Config: TOML at ~/.codex/config.toml (user) or .codex/config.toml
//     (project, only honored for "trusted" projects)
//   - MCP under [mcp_servers.<name>] tables: command/args/[env] OR url +
//     bearer_token_env_var for Streamable HTTP
//   - Programmatic: `codex mcp add <name> --env K=V -- <stdio-cmd>`
//
// Known quirks vs Claude Code:
//   1. TOML not JSON
//   2. "Trusted project" gate — known footgun (codex#3441)
//   3. NO first-class hooks system. The kernel's hook events that have no
//      Codex analog must be approximated through MCP tool calls or simply
//      no-op (the kernel returns Ok(()) silently).

import type { HostAdapter, HarnessSpec, McpServerSpec } from '@metaharness/kernel';

export const HOST_NAME = 'codex' as const;

/**
 * ADR-044: emit AGENTS.md from the harness system prompt, description, and
 * agent roster. Codex reads repo-root AGENTS.md for project instructions; the
 * adapter previously dropped `spec.systemPrompt` and `spec.agents` entirely.
 */
export function agentsMarkdown(spec: HarnessSpec): string {
  const lines: string[] = [`# ${spec.name}`, ''];
  if (spec.description) lines.push(spec.description, '');
  if (spec.systemPrompt) lines.push(spec.systemPrompt, '');
  if (spec.agents && spec.agents.length > 0) {
    lines.push('## Agents', '');
    for (const a of spec.agents) lines.push(`### ${a.name}`, '', a.systemPrompt ?? '', '');
  }
  return lines.join('\n');
}

/**
 * Escape a string for inclusion in a TOML basic string literal.
 * TOML basic strings allow common escapes (\", \\, \n, etc.).
 */
export function tomlEscape(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** TOML bare-key charset per the TOML spec: `[A-Za-z0-9_-]+`. */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * Render a TOML dotted table-header key, quoting it when it isn't a safe
 * bare key. `[mcp_servers.${s.name}]` was previously interpolated bare
 * (ADR-046 bug class): a name containing `]`, `.`, `#`, or a newline could
 * close the table header early and inject arbitrary top-level TOML keys —
 * the same "unescaped name breaks a generated structured-config document"
 * shape as #188 (hermes YAML)/#212 (github-actions YAML). TOML quoted keys
 * use the same escaping as basic strings (tomlEscape).
 */
function tomlKey(s: string): string {
  return TOML_BARE_KEY.test(s) ? s : `"${tomlEscape(s)}"`;
}

/**
 * Render a single MCP server entry as a TOML table.
 */
export function serverToToml(s: McpServerSpec): string {
  const key = tomlKey(s.name);
  const lines: string[] = [`[mcp_servers.${key}]`];
  if (s.command && s.command.length > 0) {
    lines.push(`command = "${tomlEscape(s.command[0]!)}"`);
    if (s.command.length > 1) {
      const args = s.command.slice(1).map(a => `"${tomlEscape(a)}"`).join(', ');
      lines.push(`args = [${args}]`);
    }
  } else if (s.url) {
    lines.push(`url = "${tomlEscape(s.url)}"`);
  }
  if (s.env && s.env.length > 0) {
    lines.push(`[mcp_servers.${key}.env]`);
    for (const [k, v] of s.env) {
      lines.push(`${tomlKey(k)} = "${tomlEscape(v)}"`);
    }
  }
  return lines.join('\n');
}

/**
 * Render the full config.toml content for a harness's MCP servers.
 */
export function configToml(spec: HarnessSpec): string {
  return (spec.mcpServers ?? []).map(serverToToml).join('\n\n') + '\n';
}

/** Quote one shell argument (single-quote, escaping embedded single quotes). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Strip CR/LF from a string destined for a raw `#`-comment line. A comment
 * line has no quoting to escape *into*; a literal newline in the source
 * string is the only character that can break out of it and turn the
 * remainder into a live shell statement (mirrors host-rvm's `commentSafe`).
 */
function commentSafe(s: string): string {
  return s.replace(/[\r\n]+/g, ' ');
}

/**
 * Build the `codex mcp add` command lines for the harness's MCP servers.
 * Useful for users on the programmatic-install path.
 * ADR-046 bug class: name/env/command/url were interpolated into a shell
 * line unescaped — a value containing shell metacharacters could inject
 * arbitrary commands into the generated install-mcp.sh.
 */
export function mcpAddCommands(spec: HarnessSpec): string[] {
  return (spec.mcpServers ?? []).map(s => {
    const env = (s.env ?? []).map(([k, v]) => `--env ${shellQuote(`${k}=${v}`)}`).join(' ');
    if (s.command) {
      const cmd = s.command.map(shellQuote).join(' ');
      return `codex mcp add ${env} ${shellQuote(s.name)} -- ${cmd}`.replace(/\s+/g, ' ').trim();
    }
    if (s.url) {
      return `codex mcp add ${env} ${shellQuote(s.name)} --url ${shellQuote(s.url)}`.replace(/\s+/g, ' ').trim();
    }
    return `# (skipped: ${commentSafe(s.name)} has neither command nor url)`;
  });
}

export const adapter: HostAdapter = {
  name: HOST_NAME,
  generateConfig: (spec: HarnessSpec) => {
    const out: Record<string, string> = {
      '.codex/config.toml': configToml(spec),
      'install-mcp.sh': mcpAddCommands(spec).join('\n') + '\n',
    };
    // ADR-044: emit AGENTS.md (system prompt + agent roster).
    if (spec.systemPrompt || spec.description || (spec.agents?.length ?? 0) > 0) {
      out['AGENTS.md'] = agentsMarkdown(spec);
    }
    return out;
  },
};

export default adapter;
