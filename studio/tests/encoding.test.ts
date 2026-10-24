// Encoding tests — the agentic timeline is rendered in the browser (UTF-8),
// in the Next.js server log and in a Windows console (cp1252 by default).
//
// A UTF-8 string like "🧠 planner ko bhej rahe hain…" is valid on the wire but
// a cp1252 console renders the same bytes as "ð§ planner ko bhej rahe hainâ".
// These tests pin the contract: the ENGINE's own status text is pure ASCII,
// while LLM output / file contents keep their original characters.
//
// Run: bun test tests/encoding.test.ts
import { describe, expect, test } from 'bun:test';
import { asciiText } from '../src/lib/agentic/text';

const isAscii = (s: string) => /^[\x00-\x7F]*$/.test(s);

describe('asciiText', () => {
  test('replaces the typographic characters used by the engine', () => {
    expect(asciiText('planner ko bhej rahe hain…')).toBe(
      'planner ko bhej rahe hain...'
    );
    expect(asciiText('a — b')).toBe('a - b');
    expect(asciiText('a → b')).toBe('a -> b');
    expect(asciiText('“quoted”')).toBe('"quoted"');
    expect(asciiText('a b')).toBe('a b');
  });

  test('drops emoji and pictographs (the mojibake source)', () => {
    // 🧠 = F0 9F A7 A0 -> "ð§" in cp1252
    expect(asciiText('🧠 planner ko bhej rahe hain…')).toBe(
      ' planner ko bhej rahe hain...'
    );
    expect(isAscii(asciiText('🧠 planner ko bhej rahe hain…'))).toBe(true);
    expect(isAscii(asciiText('👨‍💻 coder'))).toBe(true);
    expect(isAscii(asciiText('⚠️ Dependency cycle detected — unhe skip kiya.'))).toBe(
      true
    );
  });

  test('transliterates accented latin letters', () => {
    expect(asciiText('café')).toBe('cafe');
    expect(asciiText('naïve résumé')).toBe('naive resume');
  });

  test('keeps scripts that cannot be transliterated (meaning would be lost)', () => {
    expect(asciiText('योग')).toBe('योग');
  });

  test('is a no-op for plain ASCII', () => {
    const s = 'node hello.js -> exit=0';
    expect(asciiText(s)).toBe(s);
  });
});

describe('engine status text is cp1252-safe', () => {
  test('the live llm note contains no character outside ASCII', async () => {
    // the exact string the orchestrator emits
    const roleDef = { emoji: '🧠' };
    const note = asciiText(`${roleDef.emoji} planner ko bhej rahe hain…`);
    expect(isAscii(note)).toBe(true);
    expect(note).not.toContain('ð');
    expect(note).not.toContain('â');
    expect(note).toContain('planner ko bhej rahe hain');
  });

  test('a mojibake round trip is impossible for engine text', () => {
    // cp1252 -> utf8 mis-decode of an ASCII-only string is always identical
    const engineText = asciiText('🔧 Reviewer issues ke liye ek targeted fix cycle chal raha hai…');
    const misDecoded = Buffer.from(engineText, 'utf8').toString('latin1');
    expect(misDecoded).toBe(engineText);
  });
});
