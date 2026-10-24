// text.ts — ASCII-safe rendering of the orchestrator's own decorative text.
//
// WHY: the agentic timeline is rendered in three very different places — the
// browser UI (UTF-8, fine), the Next.js server log and the Windows console
// (codepage 1252 by default). A note such as
//
//   "🧠 planner ko bhej rahe hain…"
//
// is perfectly valid UTF-8 on the wire, but a cp1252 console renders the very
// same bytes as
//
//   "ð§ planner ko bhej rahe hainâ"
//
// i.e. mojibake. The transport is NOT the problem (the SSE frames are byte
// exact), the *rendering environment* is.
//
// The fix is to make the engine's own status text pure ASCII. Only the
// engine-generated strings go through `asciiText()` — LLM output, file
// contents and command output are NEVER touched, so a user file containing
// "café" is still reported as "café".

const TYPOGRAPHIC: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2026': '...',
  '\u2192': '->',
  '\u2190': '<-',
  '\u00a0': ' ',
  '\u2022': '*',
  '\u00b7': '.',
  '\u2212': '-',
  '\u2264': '<=',
  '\u2265': '>=',
  '\u00d7': 'x',
};

/**
 * Convert a string to plain ASCII.
 *
 * - typographic punctuation is replaced with its ASCII equivalent
 *   (… -> ..., — -> -, “ ” -> " ", → -> ->)
 * - emoji, dingbats and other symbol blocks are dropped
 * - accented latin letters are decomposed to their base letter
 *   (é -> e) instead of being mangled
 * - everything outside the ASCII range that cannot be transliterated
 *   (CJK, Devanagari, …) is kept as-is — dropping it would destroy meaning
 *   and a UTF-8 aware renderer shows it correctly.
 */
export function asciiText(input: string): string {
  if (!input) return input;
  let out = '';

  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;

    // ASCII fast path
    if (code < 0x80) {
      out += ch;
      continue;
    }

    // explicit typographic mapping
    const mapped = TYPOGRAPHIC[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }

    // emoji, dingbats, pictographs, variation selectors, zero-width joiners
    if (
      (code >= 0x1f000 && code <= 0x1faff) ||
      (code >= 0x2600 && code <= 0x27bf) ||
      (code >= 0x2b00 && code <= 0x2bff) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x1f1e6 && code <= 0x1f1ff) ||
      code === 0x200d ||
      code === 0x20e3
    ) {
      continue;
    }

    // combining marks (accent leftovers) are dropped, the base letter stays
    if (code >= 0x0300 && code <= 0x036f) continue;

    // latin-1 supplement / latin extended: decompose to the base letter
    const decomposed = ch.normalize('NFD');
    const base = decomposed.replace(/[\u0300-\u036f]/g, '');
    if (/^[\x20-\x7e]+$/.test(base)) {
      out += base;
      continue;
    }

    // keep anything else (CJK, Devanagari, …) untouched
    out += ch;
  }

  return out;
}
