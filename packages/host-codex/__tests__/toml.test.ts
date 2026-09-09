// SPDX-License-Identifier: MIT

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tomlEscape, serverToToml, configToml, mcpAddCommands, agentsMarkdown, adapter } from '../src/index.js';

describe('@metaharness/host-codex — TOML generation', () => {
  describe('tomlEscape', () => {
    it('escapes backslash, quote, newline, return, tab', () => {
      expect(tomlEscape('a\\b')).toBe('a\\\\b');
      expect(tomlEscape('a"b')).toBe('a\\"b');
      expect(tomlEscape('a\nb')).toBe('a\\nb');
      expect(tomlEscape('a\rb')).toBe('a\\rb');
      expect(tomlEscape('a\tb')).toBe('a\\tb');
    });

    it('passes ordinary strings through unchanged', () => {
      expect(tomlEscape('demo-server')).toBe('demo-server');
    });
  });

  describe('serverToToml', () => {
    it('renders a stdio server with command + args', () => {
      const s = serverToToml({
        name: 'demo',
        command: ['npx', '-y', 'demo'],
      });
      expect(s).toContain('[mcp_servers.demo]');
      expect(s).toContain('command = "npx"');
      expect(s).toContain('args = ["-y", "demo"]');
    });

    it('renders a url-based server', () => {
      const s = serverToToml({
        name: 'remote',
        url: 'https://example.com/mcp',
      });
      expect(s).toContain('[mcp_servers.remote]');
      expect(s).toContain('url = "https://example.com/mcp"');
    });

    it('renders env table when env is non-empty', () => {
      const s = serverToToml({
        name: 'x',
        command: ['demo'],
        env: [['FOO', 'bar']],
      });
      expect(s).toContain('[mcp_servers.x.env]');
      expect(s).toContain('FOO = "bar"');
    });
  });

  describe('configToml', () => {
    it('joins multiple servers with a blank line between', () => {
      const out = configToml({
        name: 'h',
        mcpServers: [
          { name: 'a', command: ['x'] },
          { name: 'b', command: ['y'] },
        ],
      });
      expect(out).toContain('[mcp_servers.a]');
      expect(out).toContain('[mcp_servers.b]');
      expect(out.endsWith('\n')).toBe(true);
    });
  });

  describe('mcpAddCommands', () => {
    it('emits the stdio invocation (shell-quoted)', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['npx', '-y', 'demo'] }],
      });
      expect(cmds[0]).toBe(`codex mcp add 'demo' -- 'npx' '-y' 'demo'`);
    });

    it('emits the url invocation (shell-quoted)', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'remote', url: 'https://x' }],
      });
      expect(cmds[0]).toBe(`codex mcp add 'remote' --url 'https://x'`);
    });

    it('emits shell-quoted --env assignments', () => {
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: 'demo', command: ['npx'], env: [['FOO', 'bar baz']] }],
      });
      expect(cmds[0]).toContain(`--env 'FOO=bar baz'`);
    });
  });

  // Dream Cycle 2026-09-09 — host-codex had TWO unfixed instances of the
  // ADR-046 unescaped-name injection class: a bare TOML table-header key
  // (serverToToml) and unescaped shell args (mcpAddCommands). Same bug
  // family already closed in hermes (#188)/github-actions (#212)/host-rvm
  // (#224)/host-openclaw (#246).
  describe('ADR-046 injection regressions (Dream Cycle 2026-09-09)', () => {
    it('serverToToml: a name with `]` cannot close the table header early', () => {
      const evil = 'demo]\n[user_agent]\noverride = "pwned';
      const s = serverToToml({ name: evil, command: ['npx'] });
      const firstLine = s.split('\n')[0]!;
      // The whole malicious name must be contained in one quoted key on one
      // line — not have broken out into a second top-level TOML table.
      expect(firstLine.startsWith('[mcp_servers."')).toBe(true);
      expect(s).not.toMatch(/^\[user_agent\]$/m);
    });

    it('serverToToml: an ordinary name stays a bare TOML key (no gratuitous quoting)', () => {
      const s = serverToToml({ name: 'demo', command: ['npx'] });
      expect(s.split('\n')[0]).toBe('[mcp_servers.demo]');
    });

    it('serverToToml: an env key with TOML-significant characters is quoted', () => {
      const s = serverToToml({ name: 'demo', command: ['npx'], env: [['weird.key', 'v']] });
      expect(s).toContain('"weird.key" = "v"');
    });

    it('mcpAddCommands: a name with shell metacharacters cannot inject a command', () => {
      const marker = `pwned-${Date.now()}`;
      const evil = `x; touch /tmp/${marker} #`;
      const cmds = mcpAddCommands({
        name: 'h',
        mcpServers: [{ name: evil, command: ['npx'] }],
      });
      // The malicious name is safely contained in a single quoted shell
      // token (single quotes suppress all bash expansion/statement syntax).
      expect(cmds[0]).toContain(`'${evil.replace(/'/g, `'"'"'`)}'`);
    });

    // Real bash-exec repro: `;` runs the next statement regardless of the
    // previous command's exit code, so an unquoted injected `touch` would
    // still fire even though `codex` itself is not installed here.
    it('mcpAddCommands: executing the generated line does not create the injected marker file', () => {
      const marker = join(tmpdir(), `host-codex-injection-proof-${Date.now()}.marker`);
      rmSync(marker, { force: true });
      const evil = `x; touch ${marker} #`;
      const cmds = mcpAddCommands({ name: 'h', mcpServers: [{ name: evil, command: ['npx'] }] });
      try {
        execSync(`bash -c ${JSON.stringify(cmds[0])}`, { stdio: 'ignore' });
      } catch { /* `codex` is not installed; that failure is expected and irrelevant here */ }
      expect(existsSync(marker)).toBe(false);
      rmSync(marker, { force: true });
    });

    // Independent-critic-caught gap (same night): the "skipped" fallback
    // comment line for a server with neither command nor url also
    // interpolated `s.name` bare — a newline there breaks out of the `#`
    // comment and turns the remainder into a live, uncommented shell line.
    it('mcpAddCommands: a skipped-server name with a newline cannot break out of the comment line', () => {
      const marker = join(tmpdir(), `host-codex-comment-injection-proof-${Date.now()}.marker`);
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

  // ADR-044 — AGENTS.md emission (systemPrompt + agents were dropped).
  describe('agentsMarkdown (ADR-044)', () => {
    it('carries name, description, system prompt, and agents', () => {
      const md = agentsMarkdown({
        name: 'demo', description: 'A demo.', systemPrompt: 'Be terse.',
        agents: [{ name: 'reviewer', systemPrompt: 'Review code.' }],
      } as any);
      expect(md).toContain('# demo');
      expect(md).toContain('A demo.');
      expect(md).toContain('Be terse.');
      expect(md).toContain('### reviewer');
      expect(md).toContain('Review code.');
    });

    it('generateConfig emits AGENTS.md when a system prompt is present', () => {
      const out = adapter.generateConfig!({ name: 'demo', systemPrompt: 'You are demo.' } as any);
      expect(Object.keys(out)).toContain('AGENTS.md');
      expect(out['AGENTS.md']).toContain('You are demo.');
    });

    it('generateConfig omits AGENTS.md for a bare spec', () => {
      const out = adapter.generateConfig!({ name: 'bare', mcpServers: [] } as any);
      expect(Object.keys(out)).not.toContain('AGENTS.md');
    });
  });
});
