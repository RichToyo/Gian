import {
  EXECUTION_DETAIL_DIFF_BYTES,
  EXECUTION_DETAIL_INPUT_BYTES,
  EXECUTION_DETAIL_MAX_BYTES,
  EXECUTION_DETAIL_MAX_FILES,
  EXECUTION_DETAIL_OUTPUT_BYTES,
  EXECUTION_DETAIL_REFERENCE_BYTES,
  EXECUTION_DETAIL_TEXT_BYTES,
  redactRemoteConversationText,
  type ExecutionItemDetail,
  type RemoteTranscriptItem,
} from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';

/** What a file list may take of one item's bound. JSON escaping at most
 *  doubles a capped text, so every kind fits EXECUTION_DETAIL_MAX_BYTES by
 *  construction: a command line and output tail (≤ 41 KiB), a tool input and
 *  output tail (≤ 37 KiB), an error message (≤ 9 KiB), and this list with a
 *  whole diff beside it. */
const FILES_BYTES = EXECUTION_DETAIL_MAX_BYTES - 2 * EXECUTION_DETAIL_DIFF_BYTES - 1024;
/** A diff this large cannot fit its cap after redaction; skip the work. */
const DIFF_SOURCE_BYTES = EXECUTION_DETAIL_DIFF_BYTES * 4;

/**
 * Detail for one execution history item (wire.execution_detail_v1), derived
 * from the stored Host event at sync time. Every text is redacted like
 * conversation text plus secret-named assignments, then cut to its cap.
 * Commands carry no cwd or stderr, files no contents beyond a whole diff that
 * fits its cap. Kinds without detail return null; a kind with detail returns
 * an object even when empty, so the controller knows this Host sent detail.
 *
 * `roots` are the directories file references are made relative to: the
 * producing cwd and the session's worktree.
 */
export function projectExecutionDetail(
  event: EventEnvelope,
  item: RemoteTranscriptItem,
  roots: ReadonlyArray<string | null | undefined>,
): ExecutionItemDetail | null {
  const data = (event.display?.data ?? {}) as unknown as Record<string, unknown>;
  switch (item.kind) {
    case 'command': {
      const command = typeof data.command === 'string' ? headText(data.command, EXECUTION_DETAIL_TEXT_BYTES) : '';
      const output = typeof data.stdout === 'string' ? outputTail(data.stdout, false)
        : typeof data.stdoutDelta === 'string' && data.stdoutDelta ? outputTail(data.stdoutDelta, true) : null;
      return { ...(command ? { command } : {}), ...(output ? { output } : {}) };
    }
    case 'file-change': {
      const bases = [typeof data.cwd === 'string' ? data.cwd : null, ...roots]
        .flatMap(root => root ? [root.replace(/\/+$/, '')] : []).filter(Boolean);
      const files = changedFiles(data.files, bases);
      const diff = typeof data.diff === 'string' ? wholeDiff(data.diff, bases) : '';
      return { ...(files.length ? { files } : {}), ...(diff ? { diff } : {}) };
    }
    case 'tool': {
      const input = data.input === undefined ? '' : headText(inputSummary(data.input), EXECUTION_DETAIL_INPUT_BYTES);
      const output = data.output === undefined || data.output === null ? null
        : outputTail(typeof data.output === 'string' ? data.output : JSON.stringify(data.output, null, 2) ?? '', false);
      return { ...(input ? { input } : {}), ...(output ? { output } : {}) };
    }
    case 'error': {
      const message = typeof data.message === 'string' ? headText(withoutStack(data.message), EXECUTION_DETAIL_TEXT_BYTES) : '';
      return message ? { message } : {};
    }
    default:
      return null;
  }
}

/** Conversation-text redaction, plus values of assignments whose name says
 *  they hold a secret (`AWS_SECRET_ACCESS_KEY=…`, `DB_PASSWORD="…"`). */
export function redactExecutionText(text: string): string {
  return redactRemoteConversationText(text)
    .replace(/\b([A-Za-z_][A-Za-z0-9_]{0,127})(\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"';&|]+)/g, (match, name: string, equals: string) => (
      SECRET_NAME.test(name) && !match.endsWith('[REDACTED]') ? `${name}${equals}[REDACTED]` : match));
}

const SECRET_NAME = /token|secret|passw(?:or)?d|passphrase|api_?key|private_?key|access_?key|credential|authorization|cookie/i;

/** Terminal escapes and control characters other than tab and line breaks
 *  render as noise and inflate JSON; drop them. */
function plainText(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function headText(raw: string, maxBytes: number): string {
  const window = utf8Head(raw, maxBytes * 2);
  const text = redactExecutionText(plainText(window)).trim();
  return Buffer.byteLength(text) <= maxBytes ? text : utf8Head(text, maxBytes - 3) + '…';
}

function outputTail(raw: string, delta: boolean): NonNullable<ExecutionItemDetail['output']> {
  // Redact a window wider than the cap so a secret cut at the window's edge
  // falls outside the tail that is sent.
  const window = utf8Tail(raw, EXECUTION_DETAIL_OUTPUT_BYTES * 2);
  const text = redactExecutionText(plainText(window));
  if (window === raw && Buffer.byteLength(text) <= EXECUTION_DETAIL_OUTPUT_BYTES) return { text, delta, truncated: false };
  let tail = utf8Tail(text, EXECUTION_DETAIL_OUTPUT_BYTES);
  // Start on a whole line when one begins near the cut.
  const newline = tail.indexOf('\n');
  if (newline >= 0 && newline < 1024 && newline < tail.length - 1) tail = tail.slice(newline + 1);
  return { text: tail, delta, truncated: true };
}

function changedFiles(value: unknown, bases: readonly string[]): NonNullable<ExecutionItemDetail['files']> {
  if (!Array.isArray(value)) return [];
  const files: NonNullable<ExecutionItemDetail['files']> = [];
  let bytes = 2;
  for (const raw of value) {
    if (files.length >= EXECUTION_DETAIL_MAX_FILES) break;
    const file = raw as { path?: unknown; kind?: unknown; added?: unknown; removed?: unknown } | null;
    if (!file || typeof file.path !== 'string' || !file.path) continue;
    const reference = utf8Head(relativeTo(file.path, bases), EXECUTION_DETAIL_REFERENCE_BYTES);
    if (!reference) continue;
    const entry: NonNullable<ExecutionItemDetail['files']>[number] = {
      reference,
      change: file.kind === 'create' ? 'create' : file.kind === 'delete' ? 'delete' : 'update',
      ...(count(file.added) !== undefined ? { added: count(file.added) } : {}),
      ...(count(file.removed) !== undefined ? { removed: count(file.removed) } : {}),
    };
    const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + size > FILES_BYTES) break;
    bytes += size;
    files.push(entry);
  }
  return files;
}

/** The whole diff with header paths relative to the worktree, or nothing:
 *  a cut diff would misreport which files and lines changed. */
function wholeDiff(raw: string, bases: readonly string[]): string {
  if (!raw.trim() || Buffer.byteLength(raw) > DIFF_SOURCE_BYTES) return '';
  const relative = raw.split('\n').map(line => /^(?:diff --git |--- |\+\+\+ |rename from |rename to |copy from |copy to )/.test(line)
    ? bases.reduce((current, base) => current.split(`${base}/`).join(''), line) : line).join('\n');
  const text = redactExecutionText(plainText(relative));
  return Buffer.byteLength(text) <= EXECUTION_DETAIL_DIFF_BYTES ? text : '';
}

function relativeTo(path: string, bases: readonly string[]): string {
  for (const base of bases) if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

/** Compact JSON like the local tool row, with secret-named values replaced
 *  and long strings shortened before they are serialized. */
function inputSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (key, entry: unknown) => {
    if (key && typeof entry === 'string' && SECRET_NAME.test(key)) return '[REDACTED]';
    return typeof entry === 'string' && entry.length > EXECUTION_DETAIL_INPUT_BYTES ? entry.slice(0, EXECUTION_DETAIL_INPUT_BYTES) : entry;
  }) ?? '';
}

/** Error text without stack frames, which name Host paths and internals. */
function withoutStack(message: string): string {
  return message.split('\n').filter(line => !/^\s+at\s/.test(line)).join('\n');
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function utf8Head(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}
