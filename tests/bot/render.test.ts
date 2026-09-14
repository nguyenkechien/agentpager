import { describe, expect, it } from 'vitest';
import {
  chunkBlocks,
  escapeHtml,
  markdownToTelegramChunks,
  renderBlocks,
  TELEGRAM_TEXT_LIMIT,
} from '../../src/bot/render.js';

function expectBalanced(html: string): void {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z]+)(?:\s[^>]*)?>/g)) {
    const [, closing, tag] = match;
    if (!tag) continue;
    if (closing) {
      expect(stack.pop(), `unexpected </${tag}> in ${html}`).toBe(tag);
    } else {
      stack.push(tag);
    }
  }
  expect(stack, `unclosed tags in ${html}`).toEqual([]);
}

function expectNoBrokenEntities(html: string): void {
  expect(html).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
}

function unescape(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<script>&"')).toBe('&lt;script&gt;&amp;&quot;');
  });
});

describe('renderBlocks', () => {
  it('renders inline formatting', () => {
    expect(renderBlocks('**b** *i* ~~s~~ `c<` [l](https://x.y?a=1&b=2)')).toEqual([
      '<b>b</b> <i>i</i> <s>s</s> <code>c&lt;</code> <a href="https://x.y?a=1&amp;b=2">l</a>',
    ]);
  });

  it('escapes raw HTML in text', () => {
    expect(renderBlocks('a <div>b</div> & c')).toEqual(['a &lt;div&gt;b&lt;/div&gt; &amp; c']);
  });

  it('renders headings as bold lines', () => {
    expect(renderBlocks('# Title *x*')).toEqual(['<b>Title <i>x</i></b>']);
  });

  it('renders fenced code with and without language', () => {
    expect(renderBlocks('```ts\nconst a = 1 < 2;\n```')).toEqual([
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    ]);
    expect(renderBlocks('```\nplain\n```')).toEqual(['<pre><code>plain</code></pre>']);
  });

  it('renders ordered and nested lists', () => {
    expect(renderBlocks('1. one\n2. two\n   - sub **b**\n')).toEqual(['1. one\n2. two\n  • sub <b>b</b>']);
  });

  it('renders task lists', () => {
    expect(renderBlocks('- [ ] todo\n- [x] done')).toEqual(['☐ todo\n☑ done']);
  });

  it('renders tables as aligned preformatted text', () => {
    expect(renderBlocks('| a | bb |\n|---|---|\n| c<c | d |')).toEqual(['<pre>a   | bb\n----+---\nc&lt;c | d</pre>']);
  });

  it('renders blockquotes', () => {
    expect(renderBlocks('> quote **x**')).toEqual(['<blockquote>quote <b>x</b></blockquote>']);
  });

  it('renders horizontal rules and skips blank space', () => {
    expect(renderBlocks('a\n\n---\n\nb')).toEqual(['a', '──────────', 'b']);
  });
});

describe('chunkBlocks', () => {
  it('packs blocks up to the limit', () => {
    expect(chunkBlocks(['aaa', 'bbb', 'ccc'], 8)).toEqual(['aaa\n\nbbb', 'ccc']);
  });

  it('splits an oversized code block by lines into balanced blocks', () => {
    const code = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, '0')} <x> & y`).join('\n');
    const chunks = markdownToTelegramChunks(`\`\`\`js\n${code}\n\`\`\``, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.startsWith('<pre><code class="language-js">')).toBe(true);
      expect(chunk.endsWith('</code></pre>')).toBe(true);
      expectBalanced(chunk);
      expectNoBrokenEntities(chunk);
    }
    const rebuilt = chunks.map((chunk) => unescape(chunk.replace(/<[^>]+>/g, ''))).join('\n');
    expect(rebuilt).toBe(code);
  });

  it('hard-splits a single code line longer than the limit', () => {
    const chunks = markdownToTelegramChunks(`\`\`\`\n${'x&'.repeat(300)}\n\`\`\``, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expectBalanced(chunk);
      expectNoBrokenEntities(chunk);
    }
  });

  it('splits an oversized paragraph without breaking entities', () => {
    const chunks = markdownToTelegramChunks('word & **bold** '.repeat(100), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
      expectBalanced(chunk);
      expectNoBrokenEntities(chunk);
    }
  });
});

describe('markdownToTelegramChunks', () => {
  it('returns no chunks for empty input', () => {
    expect(markdownToTelegramChunks('   ')).toEqual([]);
  });

  it('joins blocks with blank lines', () => {
    expect(markdownToTelegramChunks('a\n\nb')).toEqual(['a\n\nb']);
  });

  it('keeps every chunk within the Telegram limit and balanced for a large mixed document', () => {
    const section = [
      '## Section <1>',
      'Paragraph with **bold**, *italic*, `code` and a [link](https://example.com/?q=a&b=c). '.repeat(8),
      '```ts\n' + 'const value = compute(a < b && c > d);\n'.repeat(40) + '```',
      '- item one\n- item two\n  - nested & deep\n- [x] done task',
      '| col a | col b |\n|---|---|\n| 1 | <2> |\n| 3 | 4 |',
      '> quoted **text**',
    ].join('\n\n');
    const markdown = Array.from({ length: 12 }, () => section).join('\n\n');
    expect(markdown.length).toBeGreaterThan(20_000);

    const chunks = markdownToTelegramChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expectBalanced(chunk);
      expectNoBrokenEntities(chunk);
    }
  });
});
