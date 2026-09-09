// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settingsFor, mcpAddCommands, hookHandlerFor, claudeMd, agentMarkdown, adapter } from '../src/index.js';

describe('@metaharness/host-claude-code', () => {
  describe('settingsFor', () => {
    it('returns hooks-free settings when no hooks declared', () => {
      const s = settingsFor({ name: 'h' });
      expect(s.hooks).toBeUndefined();
    });

    it('emits the hooks block when hooks are declared', () => {
      const s = settingsFor({
        name: 'h',
        hooks: [
          { event: 'PreToolUse', matcher: 'Bash(*)', handler: 'pre-bash' },
        ],
      });
      expect(s.hooks?.PreToolUse).toHaveLength(1);
      expect(s.hooks?.PreToolUse?.[0]?.matcher).toBe('Bash(*)');
      expect(s.hooks?.PreToolUse?.[0]?.hooks[0]).toMatchObject({
        type: 'command',
        command: expect.stringContaining('pre-bash'),
      });
    });

    it('passes permissions through', () => {
      const s = settingsFor({
        name: 'h',
        permissions: { allow: ['Bash(npm *)'], deny: ['Read(./.env)'] },
      });
      expect(s.permissions?.allow).toEqual(['Bash(npm *)']);
      expect(s.permissions?.deny).toEqual(['Read(./.env)']);
    });
  });

  describe('mcpAddCommands', () => {
    it('emits stdio command form (shell-quoted)', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['npx', '-y', 'demo'] }],
      });
      expect(cmds[0]).toBe(`claude mcp add 'demo' -- 'npx' '-y' 'demo'`);
    });

    it('emits http transport form (shell-quoted)', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'remote', url: 'https://example.com/mcp' }],
      });
      expect(cmds[0]).toContain('--transport http');
      expect(cmds[0]).toContain('https://example.com/mcp');
      expect(cmds[0]).toBe(`claude mcp add --transport http 'remote' 'https://example.com/mcp'`);
    });
  });

  // Dream Cycle 2026-09-09 — host-claude-code was the last unfixed sibling of
  // the ADR-046 unescaped-name injection class already closed in hermes
  // (#188), github-actions (#212), host-rvm (#224), host-openclaw (#246).
  describe('ADR-046 injection regressions (Dream Cycle 2026-09-09)', () => {
    it('agentMarkdown: a name with a colon/quote cannot inject a second YAML key', () => {
      const evil = 'reviewer\ndescription: "pwned"';
      const md = agentMarkdown({ name: evil, systemPrompt: 'Review.' });
      const frontmatterEnd = md.indexOf('\n---\n', 4);
      const frontmatter = md.slice(0, frontmatterEnd);
      // Exactly one `name:` and one `description:` key in the frontmatter —
      // the attacker-controlled newline must not have produced a second one.
      expect(frontmatter.match(/^name:/m)?.length ?? 0).toBe(1);
      expect(frontmatter.match(/^description:/m)?.length ?? 0).toBe(1);
      expect(frontmatter).not.toContain('description: "pwned"\n---');
    });

    it('agentMarkdown: a YAML-reserved bare scalar name is quoted, not left bare', () => {
      const md = agentMarkdown({ name: 'true', systemPrompt: 'x' });
      expect(md).toContain('name: "true"');
    });

    it('agentMarkdown: an ordinary name stays bare (no gratuitous quoting)', () => {
      const md = agentMarkdown({ name: 'reviewer', systemPrompt: 'x' });
      expect(md).toContain('name: reviewer\n');
    });

    it('mcpAddCommands: a name with shell metacharacters cannot inject a command', () => {
      const marker = `pwned-${Date.now()}`;
      const evil = `x; touch /tmp/${marker} #`;
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: evil, command: ['npx', 'demo'] }],
      });
      // The whole malicious name — `;`, `#`, and all — must appear as one
      // single-quoted shell token (safe: single quotes have no expansions,
      // so bash never treats the embedded `;`/`#` as command syntax), not
      // split across a `;`-terminated statement.
      expect(cmds[0]).toBe(`claude mcp add '${evil.replace(/'/g, `'"'"'`)}' -- 'npx' 'demo'`);
    });

    it('mcpAddCommands: a command containing a space is quoted as one argument', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['sh', '-c', 'echo hi; rm -rf /'] }],
      });
      expect(cmds[0]).toContain(`'echo hi; rm -rf /'`);
    });

    // Real bash-exec repro (not just a string assertion): `;` always runs
    // the next statement regardless of the previous command's exit code, so
    // if the generated line were NOT quoted, the injected `touch` would
    // still fire even though `claude` itself is not installed here.
    it('mcpAddCommands: executing the generated line does not create the injected marker file', () => {
      const marker = join(tmpdir(), `host-claude-code-injection-proof-${Date.now()}.marker`);
      rmSync(marker, { force: true });
      const evil = `x; touch ${marker} #`;
      const cmds = mcpAddCommands({ name: 'h', mcpServers: [{ name: evil, command: ['npx', 'demo'] }] });
      try {
        execSync(`bash -c ${JSON.stringify(cmds[0])}`, { stdio: 'ignore' });
      } catch { /* `claude` is not installed; that failure is expected and irrelevant here */ }
      expect(existsSync(marker)).toBe(false);
      rmSync(marker, { force: true });
    });

    // Independent-critic-caught gap (same night): the "skipped" fallback
    // comment line for a server with neither command nor url also
    // interpolated `s.name` bare — a newline there breaks out of the `#`
    // comment and turns the remainder into a live, uncommented shell line.
    it('mcpAddCommands: a skipped-server name with a newline cannot break out of the comment line', () => {
      const marker = join(tmpdir(), `host-claude-code-comment-injection-proof-${Date.now()}.marker`);
      rmSync(marker, { force: true });
      const evil = `x\ntouch ${marker}\n#`;
      const cmds = mcpAddCommands({ name: 'h', mcpServers: [{ name: evil }] });
      expect(cmds[0]).not.toContain('\n');
      expect(cmds[0].startsWith('#')).toBe(true);
      try {
        execSync(`bash -c ${JSON.stringify(cmds[0])}`, { stdio: 'ignore' });
      } catch { /* unreachable: the whole line is a comment */ }
      expect(existsSync(marker)).toBe(false);
      rmSync(marker, { force: true });
    });
  });

  // ADR-044 — all 5 hook handler types reachable from the handler string.
  describe('hookHandlerFor (ADR-044)', () => {
    it('plain name → command helper', () => {
      expect(hookHandlerFor('pre-bash')).toEqual({ type: 'command', command: 'node .claude/helpers/pre-bash.cjs' });
    });
    it('https URL → http handler', () => {
      expect(hookHandlerFor('https://hooks.example/x')).toEqual({ type: 'http', url: 'https://hooks.example/x', method: 'POST' });
    });
    it('mcp:server/tool → mcp_tool handler', () => {
      expect(hookHandlerFor('mcp:memory/store')).toEqual({ type: 'mcp_tool', server: 'memory', tool: 'store' });
    });
    it('prompt: → prompt handler', () => {
      expect(hookHandlerFor('prompt:Summarize the change')).toEqual({ type: 'prompt', text: 'Summarize the change' });
    });
    it('agent: → agent handler', () => {
      expect(hookHandlerFor('agent:reviewer')).toEqual({ type: 'agent', agentType: 'reviewer' });
    });
    it('settingsFor routes a non-command handler through the mapper', () => {
      const s = settingsFor({ name: 'h', hooks: [{ event: 'Stop', handler: 'agent:summarizer' }] });
      expect(s.hooks?.Stop?.[0]?.hooks[0]).toEqual({ type: 'agent', agentType: 'summarizer' });
    });
  });

  // ADR-044 — system prompt + agents emission.
  describe('claudeMd + agents (ADR-044)', () => {
    it('claudeMd carries name, description, system prompt', () => {
      const md = claudeMd({ name: 'demo', description: 'A demo.', systemPrompt: 'Be terse.' } as any);
      expect(md).toContain('# demo');
      expect(md).toContain('A demo.');
      expect(md).toContain('Be terse.');
    });

    it('agentMarkdown emits sanitized YAML frontmatter + body', () => {
      const md = agentMarkdown({ name: 'reviewer', systemPrompt: 'Review "carefully"\nalways' });
      expect(md).toMatch(/^---\nname: reviewer\n/);
      expect(md).toContain('\\"carefully\\"');
      expect(md).not.toMatch(/description: ".*\n.*"/);
    });

    it('generateConfig emits CLAUDE.md + .claude/agents/<name>.md per agent', () => {
      const out = adapter.generateConfig!({
        name: 'demo',
        systemPrompt: 'You are demo.',
        agents: [{ name: 'reviewer', systemPrompt: 'Review.' }, { name: 'tester', systemPrompt: 'Test.' }],
      } as any);
      expect(Object.keys(out)).toContain('CLAUDE.md');
      expect(Object.keys(out)).toContain('.claude/agents/reviewer.md');
      expect(Object.keys(out)).toContain('.claude/agents/tester.md');
      expect(out['CLAUDE.md']).toContain('You are demo.');
    });

    it('no CLAUDE.md / agents when spec declares neither', () => {
      const out = adapter.generateConfig!({ name: 'bare' } as any);
      expect(Object.keys(out)).not.toContain('CLAUDE.md');
      expect(Object.keys(out).some(k => k.startsWith('.claude/agents/'))).toBe(false);
    });
  });
});
