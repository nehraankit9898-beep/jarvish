// permissions.ts — command safety classification
// SAFE       → read-only / informational commands, auto-run
// REVIEW     → writes/builds inside workspace, auto-run but logged & git-snapshotted
// DESTRUCTIVE→ requires EXPLICIT user approval from UI before running
// FORBIDDEN  → never allowed, orchestrator refuses
//
// SECURITY: the classifier must not be fooled by shell syntax that smuggles a
// second command past the pattern list. `ls $(rm -rf /)`, `cat x > /etc/passwd`
// and `bash -c "rm -rf /"` all START with a harmless word, so every command is
// additionally decomposed into its nested payloads / redirections and those
// are classified too. The strictest verdict always wins.

export type Permission = 'safe' | 'review' | 'destructive' | 'forbidden';

const SAFE_PATTERNS: RegExp[] = [
  /^(ls|pwd|cat|head|tail|wc|file|stat|which|whoami|echo|printf|date|uname|env(print)?|printenv)\b/,
  /^(node|python3?|pip3?|npm|npx|bun|bunx|tsc|git)\s+(-v|--version|version)\b/,
  /^git\s+(status|log|diff|show|branch|remote)\b/,
  /^git\s+(rev-parse|rev-list|diff-tree|ls-files|cat-file|describe|symbolic-ref|name-rev)\b/,
  /^(find|grep|rg)\b.*\s(-l|--files-with-matches|-n|--line-number)/,
  /^(find|grep|rg)\s/,
  /^tree\b/,
  /^pytest(--version)?\b/,
  /^python3?\s+-m\s+pytest\s+(-v|--co|--collect-only)\b/,
];

const FORBIDDEN_PATTERNS: RegExp[] = [
  /rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+\/(\s|$)/, // rm -rf /
  /rm\s+-[a-zA-Z]*r[a-zA-Z]*[fF]?[a-zA-Z]*\s+~|\$HOME/,
  /:\(\)\s*\{.*\};:/, // fork bomb
  /(mkfs|fdisk|dd\s+if=).*(\/dev\/(sd|nvme|hd))/,
  /shutdown|reboot|halt|poweroff/,
  /:\s*;\s*sudo/,
  /chmod\s+777\s+\//,
  />\s*\/dev\/sd/,
  /history\s+-c/,
  /curl[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, // curl | sh
  /wget[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
];

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /^rm\b/,
  /^rmdir\b/,
  /^mv\s+\/|^cp\s+.*\s+\//, // moving/copying into system roots
  /^git\s+(push|reset\s+--hard|clean|checkout\s+--|restore|rebase|filter-branch)/,
  /^npm\s+(unpublish|logout)/,
  /^pip\s+uninstall|^npm\s+(remove|uninstall|rm)\b/,
  /^kill(all)?\b|^pkill\b/,
  /^sudo\b/,
  /^ch(mod|own)\b/,
  /^git\s+remote\s+(remove|set-url)/,
  /^docker\s+(rm|rmi|system\s+prune)|^docker\s+volume\s+rm/,
  /^(curl|wget)\b.*(-o|--output|-O)\s+\//, // download over system files
  /^>\s*\/|^>\s*~/, // redirect overwrite outside workspace
  /^truncate\b|^shred\b/,
  /^deploy|^npm\s+publish|^bun\s+publish/,
];

const REVIEW_PATTERNS: RegExp[] = [
  /^(node|bun|tsx|ts-node|python3?|pytest|bash|sh)\b/, // running code
  /^(npm|npx|bun|bunx|pnpm|yarn)\s+(run|test|exec|install|i|ci|create)\b/,
  /^pip3?\s+install\b/,
  /^git\s+(add|commit|init|config|stash|tag)\b/,
  /^git\s+(checkout\s+-b|switch\s+-c)\b/,
  /^mkdir|touch\b/,
  /^(cp|mv)\b/,
  /^(gcc|g\+\+|javac|go|cargo|make)\b/,
  /^python3?\s+-m\s+(pip|venv|unittest)\b/,
  /^(tar|unzip|zip|gzip)\b/,
];

export interface CommandCheck {
  permission: Permission;
  reason: string;
}

const RANK: Record<Permission, number> = {
  safe: 0,
  review: 1,
  destructive: 2,
  forbidden: 3,
};

/** System locations a redirect must never be allowed to write to. */
const SYSTEM_WRITE_TARGETS = [
  /^\/(etc|usr|bin|sbin|boot|dev|proc|sys|root|lib)(\/|$)/i,
  /^\/(var\/lib|var\/log|var\/spool)(\/|$)/i,
  /^[A-Za-z]:[\\/](Windows|System32|Program Files|ProgramData)(\\|$)/i,
  /^\/(home|Users)(\/|$)/i,
];

/** Shell wrappers whose payload is a whole command of its own. */
const SHELL_WRAPPER_RE =
  /^\s*(?:sudo\s+)?(?:ba|z|k|da|a|fi)?sh\s+-(?:c|Command)\s+([\s\S]+)$/;
const EVAL_RE = /^\s*eval\s+([\s\S]+)$/;
const FIND_EXEC_RE = /^\s*find\b[\s\S]*\s-(?:exec|execdir)\s+([\s\S]+)$/;

const MAX_NESTING_DEPTH = 4;

function stripOuterQuotes(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

/**
 * Pull out every payload that the SHELL executes but the pattern lists never
 * see: `$( ... )`, backticks, `sh -c '...'`, `eval '...'` and
 * `find ... -exec '...'`.
 */
function extractNestedPayloads(command: string): {
  payloads: string[];
  rest: string;
} {
  const payloads: string[] = [];
  let rest = '';
  let i = 0;

  while (i < command.length) {
    if (command.startsWith('$(', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')') depth--;
        j++;
      }
      payloads.push(command.slice(i + 2, Math.max(i + 2, j - 1)));
      rest += ' __NESTED__ ';
      i = j;
      continue;
    }
    if (command[i] === '`') {
      const end = command.indexOf('`', i + 1);
      if (end === -1) {
        rest += command.slice(i);
        break;
      }
      payloads.push(command.slice(i + 1, end));
      rest += ' __NESTED__ ';
      i = end + 1;
      continue;
    }
    rest += command[i];
    i++;
  }

  // shell wrappers only apply when they start the command
  const wrapperMatch =
    rest.match(SHELL_WRAPPER_RE) ??
    rest.match(EVAL_RE) ??
    rest.match(FIND_EXEC_RE);
  if (wrapperMatch) {
    payloads.push(stripOuterQuotes(wrapperMatch[1]));
    rest = '__NESTED__';
  }

  return { payloads, rest };
}

/**
 * Find output redirections and pull them out of the command.
 * Quoted text is skipped (an echo of "a > b" is not a write) and fd
 * duplication (`2>&1`) is not a file write.
 */
function extractRedirects(command: string): {
  targets: string[];
  rest: string;
} {
  const targets: string[] = [];
  let rest = '';
  let i = 0;
  let quote: string | null = null;

  while (i < command.length) {
    const ch = command[i];
    if (quote) {
      rest += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      rest += ch;
      i++;
      continue;
    }
    const isRedirect = ch === '>' || (ch === '&' && command[i + 1] === '>');
    if (isRedirect) {
      let j = i;
      if (ch === '&') j++; // "&>" / "&>>" → redirect stdout AND stderr
      if (command[j] === '>') j++; // ">>" → append
      if (command[j] === '&') {
        const after = command[j + 1];
        if (after !== undefined && /[0-9]/.test(after)) {
          // fd duplication ("2>&1") — not a file write, just drop the token
          j += 2;
          rest += ' __REDIRECT__ ';
          i = j;
          continue;
        }
        j++; // ">&word" → redirect to a file named "word"
      }
      while (command[j] === ' ' || command[j] === '\t') j++;
      let target = '';
      if (command[j] === '"' || command[j] === "'") {
        const q = command[j];
        j++;
        while (j < command.length && command[j] !== q) {
          target += command[j];
          j++;
        }
        j++; // closing quote
      } else {
        while (j < command.length && !/[\s;|&()<>]/.test(command[j])) {
          target += command[j];
          j++;
        }
      }
      if (target && !/^\d+$/.test(target)) {
        targets.push(target);
      }
      rest += ' __REDIRECT__ ';
      i = j;
      continue;
    }
    rest += ch;
    i++;
  }

  return { targets, rest };
}

/**
 * find/grep/rg flags that BULK-DELETE or EXECUTE against every match.
 * A bare `find` is safe (read-only listing) but `find . -name '*.log' -delete`
 * destroys data, so it must escalate to destructive (H1).
 */
const FIND_BULK_HARM_RE = /(?:^|\s)-delete\b/;

/** mv/cp with a target OUTSIDE the workspace — moving/copying INTO system or
 *  home locations must never auto-run (H2: `mv a.txt /etc/passwd`).
 *  The DESTINATION is the last whitespace-delimited token of the command. */
function classifyFileMoveTarget(part: string): { permission: Permission; reason: string } | null {
  const m = part.match(/^(?:mv|cp)\s+([\s\S]+)$/);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return null;
  // last token = destination; strip surrounding quotes
  const tokens = rest.split(/\s+/);
  const destRaw = tokens[tokens.length - 1] ?? '';
  const dest = stripOuterQuotes(destRaw);
  const isEscapeTarget =
    dest.startsWith('/') ||
    dest.startsWith('~') ||
    /^\$HOME/i.test(dest) ||
    /^[A-Za-z]:[\\/]/.test(dest);
  if (!isEscapeTarget) return null; // relative target stays inside the workspace
  if (SYSTEM_WRITE_TARGETS.some((re) => re.test(dest))) {
    return {
      permission: 'destructive',
      reason: `${part.split(/\s+/)[0]} writes into a system location (${dest}) — approval required`,
    };
  }
  return {
    permission: 'destructive',
    reason: `${part.split(/\s+/)[0]} writes outside the workspace (${dest}) — approval required`,
  };
}

function classifyPart(part: string): { permission: Permission; reason: string } {
  if (FORBIDDEN_PATTERNS.some((re) => re.test(part))) {
    return {
      permission: 'forbidden',
      reason: 'Matches a forbidden pattern (system destruction / pipe-to-shell)',
    };
  }
  if (DESTRUCTIVE_PATTERNS.some((re) => re.test(part))) {
    return {
      permission: 'destructive',
      reason: 'Can delete/overwrite data or leave the machine — needs approval',
    };
  }
  // H1: a read-only-looking find/grep/rg that actually destroys matches
  if (/^(find|grep|rg)\b/.test(part) && FIND_BULK_HARM_RE.test(part)) {
    return {
      permission: 'destructive',
      reason: 'find/grep/rg with -delete removes every match — approval required',
    };
  }
  // H2: mv/cp whose DESTINATION is a system or home location
  const moveVerdict = classifyFileMoveTarget(part);
  if (moveVerdict) return moveVerdict;
  if (SAFE_PATTERNS.some((re) => re.test(part))) {
    return { permission: 'safe', reason: 'Read-only / informational' };
  }
  if (REVIEW_PATTERNS.some((re) => re.test(part))) {
    return {
      permission: 'review',
      reason: 'Build/run command inside isolated workspace',
    };
  }
  return {
    permission: 'destructive',
    reason: 'Unknown command — manual approval required (safe default)',
  };
}

function classifyRedirectTarget(target: string): {
  permission: Permission;
  reason: string;
} {
  const isAbsolute =
    target.startsWith('/') ||
    target.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(target);
  if (!isAbsolute) {
    return { permission: 'safe', reason: 'Redirect stays inside the workspace' };
  }
  if (SYSTEM_WRITE_TARGETS.some((re) => re.test(target))) {
    return {
      permission: 'forbidden',
      reason: `Redirect target is a system location: ${target}`,
    };
  }
  return {
    permission: 'destructive',
    reason: `Redirect writes outside the workspace: ${target}`,
  };
}

/**
 * Classify a shell command. Rules (first match wins):
 * 1. FORBIDDEN patterns → never run
 * 2. DESTRUCTIVE patterns → explicit UI approval required
 * 3. SAFE patterns → auto-run
 * 4. REVIEW patterns → auto-run inside isolated workspace (git snapshot after)
 * 5. anything unknown → destructive (approval) — safe default
 *
 * Nested payloads (`$(...)`, backticks, `sh -c`, `eval`, `find -exec`) and
 * output redirections are classified as well and the strictest verdict wins.
 */
export function checkCommand(rawCommand: string): CommandCheck {
  return classify(rawCommand, 0);
}

function classify(rawCommand: string, depth: number): CommandCheck {
  // NOTE: newlines are deliberately NOT collapsed here — in a POSIX shell a
  // newline is a command separator exactly like `;`, so a multi-line payload
  // ("echo hi\nrm -rf x") is TWO commands. Every line is classified
  // separately below and the strictest verdict wins (C1).
  const command = String(rawCommand ?? '').trim().replace(/[ \t]+/g, ' ');

  if (!command) {
    return { permission: 'forbidden', reason: 'Empty command' };
  }
  if (command.length > 500) {
    return {
      permission: 'forbidden',
      reason: 'Command too long (>500 chars)',
    };
  }
  // whole-command forbidden check FIRST (catches pipes like `curl x | sh`)
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(command)) {
      return {
        permission: 'forbidden',
        reason: 'Matches a forbidden pattern (system destruction / pipe-to-shell)',
      };
    }
  }

  const { payloads, rest: afterNested } = extractNestedPayloads(command);
  const { targets, rest: afterRedirects } = extractRedirects(afterNested);

  // chained commands get the STRICTEST permission of any part
  const parts = afterRedirects
    .split(/\s*(?:&&|\|\||;|\||&)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

  // C1: a multi-line command is SEVERAL shell commands — classify every line
  // on its own so a harmless-looking first line cannot smuggle a destructive
  // second line ("echo hi\nrm -rf x") past the pattern lists.
  const lines = String(rawCommand ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (parts.length > 6) {
    return {
      permission: 'forbidden',
      reason: 'Too many chained commands (>6)',
    };
  }

  let worst: Permission = 'safe';
  const reasons: string[] = [];

  const record = (perm: Permission, why: string) => {
    reasons.push(why);
    if (RANK[perm] > RANK[worst]) worst = perm;
  };

  for (const part of parts) {
    const verdict = classifyPart(part);
    record(verdict.permission, `${part} → ${verdict.permission}`);
  }

  if (lines.length > 1) {
    for (const line of lines) {
      const verdict = classifyPart(line);
      record(verdict.permission, `line "${line}" → ${verdict.permission}`);
    }
  }

  for (const target of targets) {
    const verdict = classifyRedirectTarget(target);
    record(verdict.permission, `redirect ${target} → ${verdict.permission}`);
  }

  if (depth < MAX_NESTING_DEPTH) {
    for (const payload of payloads) {
      const inner = classify(payload, depth + 1);
      record(inner.permission, `nested \`${payload}\` → ${inner.permission}`);
    }
  } else if (payloads.length) {
    record('destructive', 'Nested command inside command — needs approval');
  }

  return { permission: worst, reason: reasons.join(' ; ') };
}
