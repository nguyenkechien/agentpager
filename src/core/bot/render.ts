import { lexer, type MarkedToken, type Token, type Tokens } from 'marked';

export const TELEGRAM_TEXT_LIMIT = 4096;

const BLOCK_SEPARATOR = '\n\n';
const HORIZONTAL_RULE = '──────────';
const CODE_CLOSE = '</code></pre>';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeHtml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function renderInlineTokens(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return escapeHtml(fallback);
  return tokens.map(renderInline).join('');
}

function renderInline(token: Token): string {
  const known = token as MarkedToken;
  switch (known.type) {
    case 'text':
      return known.tokens ? renderInlineTokens(known.tokens, known.text) : escapeHtml(known.text);
    case 'escape':
      return escapeHtml(known.text);
    case 'strong':
      return `<b>${renderInlineTokens(known.tokens, known.text)}</b>`;
    case 'em':
      return `<i>${renderInlineTokens(known.tokens, known.text)}</i>`;
    case 'del':
      return `<s>${renderInlineTokens(known.tokens, known.text)}</s>`;
    case 'codespan':
      return `<code>${escapeHtml(known.text)}</code>`;
    case 'br':
      return '\n';
    case 'link':
      return `<a href="${escapeHtml(known.href)}">${renderInlineTokens(known.tokens, known.text)}</a>`;
    case 'image':
      return `<a href="${escapeHtml(known.href)}">${escapeHtml(known.text || known.href)}</a>`;
    case 'html':
      return escapeHtml(known.text);
    case 'checkbox':
      return '';
    default:
      return escapeHtml(token.raw);
  }
}

function plainText(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  return tokens
    .map((token) => {
      const known = token as MarkedToken;
      if (known.type === 'br') return '\n';
      if (known.type === 'checkbox') return '';
      if ('tokens' in known && Array.isArray(known.tokens)) return plainText(known.tokens, known.text);
      return 'text' in known && typeof known.text === 'string' ? known.text : token.raw;
    })
    .join('');
}

function renderList(list: Tokens.List, depth: number): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  list.items.forEach((item, index) => {
    let marker: string;
    if (item.task) marker = item.checked ? '☑' : '☐';
    else if (list.ordered) marker = `${(typeof list.start === 'number' ? list.start : 1) + index}.`;
    else marker = '•';

    const content: string[] = [];
    const nested: string[] = [];
    for (const child of item.tokens) {
      const known = child as MarkedToken;
      if (known.type === 'list') nested.push(renderList(known, depth + 1));
      else if (known.type === 'checkbox') continue;
      else if (known.type === 'text' || known.type === 'paragraph') content.push(renderInlineTokens(known.tokens, known.text));
      else {
        const rendered = renderBlock(child);
        if (rendered !== null) content.push(rendered);
      }
    }
    lines.push(`${indent}${marker} ${content.join('\n')}`);
    lines.push(...nested);
  });
  return lines.join('\n');
}

function renderTable(table: Tokens.Table): string {
  const rows = [table.header, ...table.rows].map((row) => row.map((cell) => plainText(cell.tokens, cell.text)));
  const widths = table.header.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  const formatRow = (row: string[]): string =>
    row
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join(' | ')
      .trimEnd();
  const [header, ...body] = rows;
  const lines = [formatRow(header ?? []), widths.map((width) => '-'.repeat(width)).join('-+-'), ...body.map(formatRow)];
  return `<pre>${escapeHtml(lines.join('\n'))}</pre>`;
}

function renderBlock(token: Token): string | null {
  const known = token as MarkedToken;
  switch (known.type) {
    case 'space':
    case 'def':
      return null;
    case 'paragraph':
    case 'text':
      return renderInlineTokens(known.tokens, known.text);
    case 'heading':
      return `<b>${renderInlineTokens(known.tokens, known.text)}</b>`;
    case 'code': {
      const language = known.lang?.trim().split(/\s+/)[0];
      const classAttr = language ? ` class="language-${escapeHtml(language)}"` : '';
      return `<pre><code${classAttr}>${escapeHtml(known.text)}${CODE_CLOSE}`;
    }
    case 'blockquote':
      return `<blockquote>${renderTokens(known.tokens).join('\n')}</blockquote>`;
    case 'list':
      return renderList(known, 0);
    case 'table':
      return renderTable(known);
    case 'hr':
      return HORIZONTAL_RULE;
    case 'html':
      return escapeHtml(known.text);
    default:
      return escapeHtml(token.raw);
  }
}

function renderTokens(tokens: Token[]): string[] {
  return tokens.map(renderBlock).filter((block): block is string => block !== null && block.length > 0);
}

export function renderBlocks(markdown: string): string[] {
  return renderTokens(lexer(markdown));
}

/** Splits text into units that fit `capacity` once escaped, preferring line breaks, then spaces. */
function breakUnits(raw: string, capacity: number): string[] {
  return raw
    .split(/(?<=\n)/)
    .flatMap((line) => (escapeHtml(line).length <= capacity ? [line] : line.split(/(?<=[ \t])/)));
}

/** Splits raw text so that each escaped piece fits in `capacity` characters. */
function splitRawByEscapedLength(raw: string, capacity: number, preferBreaks: boolean): string[] {
  const pieces: string[] = [];
  const units = preferBreaks ? breakUnits(raw, capacity) : [raw];
  let current = '';
  let currentLength = 0;

  const pushCurrent = (): void => {
    if (current.length > 0) pieces.push(current);
    current = '';
    currentLength = 0;
  };

  for (const unit of units) {
    const unitLength = escapeHtml(unit).length;
    if (currentLength + unitLength <= capacity) {
      current += unit;
      currentLength += unitLength;
      continue;
    }
    pushCurrent();
    if (unitLength <= capacity) {
      current = unit;
      currentLength = unitLength;
      continue;
    }
    for (const char of unit) {
      const charLength = escapeHtml(char).length;
      if (currentLength + charLength > capacity) pushCurrent();
      current += char;
      currentLength += charLength;
    }
  }
  pushCurrent();
  return pieces;
}

function splitCodeBlock(block: string, limit: number): string[] {
  const openEnd = block.indexOf('>', '<pre><code'.length) + 1;
  const open = block.slice(0, openEnd);
  const capacity = limit - open.length - CODE_CLOSE.length;
  const code = unescapeHtml(block.slice(openEnd, block.length - CODE_CLOSE.length));

  const groups: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const pushCurrent = (): void => {
    if (current.length > 0) groups.push(current.join('\n'));
    current = [];
    currentLength = 0;
  };

  for (const line of code.split('\n')) {
    const lineLength = escapeHtml(line).length;
    const added = current.length === 0 ? lineLength : lineLength + 1;
    if (currentLength + added <= capacity) {
      current.push(line);
      currentLength += added;
      continue;
    }
    pushCurrent();
    if (lineLength <= capacity) {
      current.push(line);
      currentLength = lineLength;
    } else {
      groups.push(...splitRawByEscapedLength(line, capacity, false));
    }
  }
  pushCurrent();
  return groups.map((group) => `${open}${escapeHtml(group)}${CODE_CLOSE}`);
}

function splitOversizedBlock(block: string, limit: number): string[] {
  if (block.startsWith('<pre><code') && block.endsWith(CODE_CLOSE)) return splitCodeBlock(block, limit);
  // Other oversized blocks degrade to plain text so every piece stays tag-balanced.
  const raw = unescapeHtml(block.replace(/<[^>]+>/g, ''));
  return splitRawByEscapedLength(raw, limit, true).map(escapeHtml);
}

export function chunkBlocks(blocks: readonly string[], limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  const pieces = blocks.flatMap((block) => (block.length <= limit ? [block] : splitOversizedBlock(block, limit)));
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current === '') {
      current = piece;
    } else if (current.length + BLOCK_SEPARATOR.length + piece.length <= limit) {
      current += BLOCK_SEPARATOR + piece;
    } else {
      chunks.push(current);
      current = piece;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

export function markdownToTelegramChunks(markdown: string, limit: number = TELEGRAM_TEXT_LIMIT): string[] {
  if (markdown.trim() === '') return [];
  return chunkBlocks(renderBlocks(markdown), limit);
}
