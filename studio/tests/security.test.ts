// Security regression tests — command injection, shell-classifier bypass,
// path traversal and protocol parsing.
// Run: bun test tests/security.test.ts
import { describe, expect, test } from 'bun:test';
import { checkCommand } from '../src/lib/agentic/permissions';
import { isSafeGitRef, diffBetween, InvalidGitRefError } from '../src/lib/agentic/git-tools';
import {
  taskWorkspace,
  resolveSafe,
  isSafeTaskId,
  createWorkspace,
  removeWorkspace,
} from '../src/lib/agentic/workspace';
import { parseActions } from '../src/lib/agentic/file-tools';
import { executeCommand, CommandDeniedError, normalizeCommand } from '../src/lib/agentic/terminal';

describe('git ref validation (command injection)', () => {
  test('rejects shell metacharacters in refs', () => {
    for (const ref of [
      'HEAD; rm -rf /',
      'HEAD && whoami',
      'HEAD | cat /etc/passwd',
      '$(whoami)',
      '`id`',
      'HEAD" && rm -rf /',
      'HEAD\nrm -rf /',
      'HEAD > out',
    ]) {
      expect(isSafeGitRef(ref)).toBe(false);
    }
  });

  test('rejects option-like refs (git argument injection)', () => {
    expect(isSafeGitRef('--upload-pack=evil.sh')).toBe(false);
    expect(isSafeGitRef('--exec-path=/tmp')).toBe(false);
    expect(isSafeGitRef('-rf')).toBe(false);
  });

  test('accepts ordinary refs', () => {
    for (const ref of ['HEAD', 'HEAD~1', 'HEAD^', 'main', 'refs/heads/feature/x', 'a1b2c3d']) {
      expect(isSafeGitRef(ref)).toBe(true);
    }
  });

  test('diffBetween refuses an injected ref instead of running it', async () => {
    let err: unknown = null;
    try {
      await diffBetween('inject-test-task', 'HEAD; rm -rf /', 'HEAD');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidGitRefError);
  });
});

describe('shell classifier cannot be bypassed', () => {
  test('command substitution is classified, not ignored', () => {
    // starts with "ls" but runs rm -rf / in a subshell
    expect(checkCommand('ls $(rm -rf /)').permission).toBe('forbidden');
    expect(checkCommand('ls `rm -rf /`').permission).toBe('forbidden');
  });

  test('shell -c wrappers are unwrapped and classified', () => {
    expect(checkCommand('bash -c "rm -rf /"').permission).toBe('forbidden');
    expect(checkCommand('sh -c "rm -rf /"').permission).toBe('forbidden');
    expect(checkCommand("eval 'rm -rf /'").permission).toBe('forbidden');
    expect(checkCommand('sudo bash -c "rm -rf /"').permission).toBe('forbidden');
  });

  test('find -exec payloads are classified', () => {
    expect(checkCommand('find . -exec rm {} \\;').permission).toBe('destructive');
  });

  test('background operator does not hide a destructive command', () => {
    expect(checkCommand('ls & rm -rf /').permission).toBe('forbidden');
    expect(checkCommand('ls & rm data.csv').permission).toBe('destructive');
  });

  test('redirects to system paths are blocked', () => {
    expect(checkCommand('cat notes.txt > /etc/passwd').permission).toBe('forbidden');
    expect(checkCommand('cat notes.txt > C:\\Windows\\system32\\drivers\\etc\\hosts').permission).toBe(
      'forbidden'
    );
    expect(checkCommand('cat notes.txt > /tmp/out.txt').permission).toBe('destructive');
  });

  test('redirect inside the workspace stays allowed', () => {
    expect(checkCommand('echo hi > out.txt').permission).toBe('safe');
    expect(checkCommand('npm test 2>&1').permission).toBe('review');
  });

  test('quoted text that looks like a redirect is not treated as one', () => {
    expect(checkCommand('echo "a > b"').permission).toBe('safe');
  });
});

describe('workspace path safety', () => {
  test('rejects task ids that are not plain identifiers', () => {
    expect(isSafeTaskId('../..')).toBe(false);
    expect(isSafeTaskId('a/b')).toBe(false);
    expect(isSafeTaskId('..')).toBe(false);
    expect(isSafeTaskId('')).toBe(false);
    expect(isSafeTaskId('clx123abc')).toBe(true);
  });

  test('taskWorkspace refuses traversal ids', () => {
    let threw = false;
    try {
      taskWorkspace('../..');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('resolveSafe rejects ".." segments but allows dotted file names', async () => {
    let threw = false;
    try {
      await resolveSafe('traversal-test-task', '../outside.txt');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    const abs = await resolveSafe('traversal-test-task', 'a..b/file.txt');
    expect(abs).toContain('a..b');
  });

  test('resolveSafe rejects empty paths', async () => {
    let threw = false;
    try {
      await resolveSafe('traversal-test-task', '');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('approval matching uses the same normalization as execution', () => {
  test('normalizeCommand collapses whitespace consistently', () => {
    expect(normalizeCommand('  rm   -f   x.txt ')).toBe('rm -f x.txt');
  });

  test('an approved command is not denied because of different spacing', async () => {
    const taskId = 'approval-test-task';
    await createWorkspace(taskId);
    try {
      // destructive → needs approval; the approved list holds the "normal"
      // spelling while the executed command has extra spaces
      const res = await executeCommand(taskId, 'rm   -f   nothing.txt', {
        approvedCommands: ['rm -f nothing.txt'],
      });
      expect(res.permission).toBe('destructive');
    } catch (err) {
      // a missing `rm` on Windows must fail with an exit code, never with a
      // CommandDeniedError
      expect(err).not.toBeInstanceOf(CommandDeniedError);
      throw err;
    } finally {
      await removeWorkspace(taskId);
    }
  });

  test('an unapproved destructive command is still denied', async () => {
    const taskId = 'approval-test-task-2';
    await createWorkspace(taskId);
    try {
      let denied = false;
      try {
        await executeCommand(taskId, 'rm -f nothing.txt');
      } catch (err) {
        denied = err instanceof CommandDeniedError;
      }
      expect(denied).toBe(true);
    } finally {
      await removeWorkspace(taskId);
    }
  });
});

describe('coder protocol parser', () => {
  test('raw file content stops at the "### END" terminator', () => {
    const reply = [
      '### FILE: notes.md',
      'line one',
      '### END',
      '### RUN: ls -la',
      '### END',
    ].join('\n');
    const actions = parseActions(reply);
    expect(actions.files.length).toBe(1);
    expect(actions.files[0].path).toBe('notes.md');
    expect(actions.files[0].content).toBe('line one');
    expect(actions.commands).toEqual(['ls -la']);
  });
});
