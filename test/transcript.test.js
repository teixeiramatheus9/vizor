import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseLastAssistantMessage,
  parsePendingQuestion,
  parseAiTitle,
  readTranscriptSnapshot,
  readLastAssistantMessage,
  readAiTitle,
  parseEditReason,
  parseLastBashCommand,
  readEditReason,
} from '../src/main/transcript.js';

const assistantLine = (text) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const userLine = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('parseLastAssistantMessage', () => {
  it('returns the text of the LAST assistant entry', () => {
    const jsonl = [assistantLine('first'), userLine('question'), assistantLine('last answer')].join('\n');
    expect(parseLastAssistantMessage(jsonl)).toBe('last answer');
  });

  it('joins multiple text blocks and skips non-text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'part one' },
          { type: 'tool_use', name: 'Bash', input: {} },
          { type: 'text', text: 'part two' },
        ],
      },
    });
    expect(parseLastAssistantMessage(line)).toBe('part one\npart two');
  });

  it('skips malformed lines and assistant entries without text', () => {
    const toolOnly = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    });
    const jsonl = [assistantLine('real text'), 'not json {{{', toolOnly].join('\n');
    expect(parseLastAssistantMessage(jsonl)).toBe('real text');
  });

  it('returns null when there is no assistant text', () => {
    expect(parseLastAssistantMessage(userLine('hi'))).toBeNull();
    expect(parseLastAssistantMessage('')).toBeNull();
  });

  it('truncates long messages to 1500 chars plus ellipsis', () => {
    const result = parseLastAssistantMessage(assistantLine('x'.repeat(3000)));
    expect(result).toHaveLength(1501);
    expect(result.endsWith('…')).toBe(true);
  });
});

const askLine = () =>
  JSON.stringify({
    parentUuid: 'x',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question: 'Qual branch você quer?',
                header: 'Branch',
                options: [
                  { label: 'feat/sdv-nova', description: 'a mais recente' },
                  { label: 'feat/sdv-antiga', description: 'a estável' },
                ],
              },
            ],
          },
        },
      ],
    },
  });

describe('parsePendingQuestion', () => {
  it('extracts question and option labels from a trailing AskUserQuestion', () => {
    const jsonl = [userLine('faz ai'), assistantLine('vou perguntar'), askLine()].join('\n');
    expect(parsePendingQuestion(jsonl)).toEqual({
      questions: [
        {
          question: 'Qual branch você quer?',
          multiSelect: false,
          options: ['feat/sdv-nova', 'feat/sdv-antiga'],
        },
      ],
    });
  });

  it('returns null when the user already answered (user entry after the ask)', () => {
    const jsonl = [askLine(), userLine('a primeira')].join('\n');
    expect(parsePendingQuestion(jsonl)).toBeNull();
  });

  it('returns null when there is no pending ask', () => {
    expect(parsePendingQuestion([userLine('oi'), assistantLine('salve')].join('\n'))).toBeNull();
    expect(parsePendingQuestion('')).toBeNull();
  });
});

const aiTitleLine = (title) => JSON.stringify({ type: 'ai-title', aiTitle: title });

describe('parseAiTitle', () => {
  it('returns the LAST ai-title entry', () => {
    const jsonl = [
      aiTitleLine('primeiro tema'),
      assistantLine('respondi'),
      aiTitleLine('tema atualizado'),
      assistantLine('respondi de novo'),
    ].join('\n');
    expect(parseAiTitle(jsonl)).toBe('tema atualizado');
  });

  it('skips malformed lines and entries without a string aiTitle', () => {
    const jsonl = [
      aiTitleLine('tema real'),
      'not json {{{',
      JSON.stringify({ type: 'ai-title', aiTitle: 42 }),
      JSON.stringify({ type: 'ai-title' }),
    ].join('\n');
    expect(parseAiTitle(jsonl)).toBe('tema real');
  });

  it('ignores blank titles', () => {
    expect(parseAiTitle(aiTitleLine('   '))).toBeNull();
  });

  it('returns null when there is no ai-title', () => {
    expect(parseAiTitle([userLine('oi'), assistantLine('salve')].join('\n'))).toBeNull();
    expect(parseAiTitle('')).toBeNull();
  });
});

describe('readAiTitle', () => {
  it('reads the title from a real file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-ai-title-'));
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${aiTitleLine('Windows update check não funciona')}\n${assistantLine('oi')}\n`);
    expect(await readAiTitle(file)).toBe('Windows update check não funciona');
  });

  it('returns null for a missing file', async () => {
    expect(await readAiTitle('/nonexistent/nope.jsonl')).toBeNull();
  });
});

describe('readTranscriptSnapshot', () => {
  it('returns last assistant message and pending question from a file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-snapshot-'));
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${assistantLine('trabalhei muito')}\n${askLine()}\n`);
    const snapshot = await readTranscriptSnapshot(file);
    expect(snapshot.lastAssistantMessage).toBe('trabalhei muito');
    expect(snapshot.pendingQuestion.questions[0].options).toHaveLength(2);
  });

  it('returns empty snapshot for a missing file', async () => {
    expect(await readTranscriptSnapshot('/nonexistent/nope.jsonl')).toEqual({
      lastAssistantMessage: null,
      pendingQuestion: null,
    });
  });
});

describe('readLastAssistantMessage', () => {
  it('reads from a real file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-transcript-'));
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, `${assistantLine('from disk')}\n`);
    expect(await readLastAssistantMessage(file)).toBe('from disk');
  });

  it('returns null for a missing file', async () => {
    expect(await readLastAssistantMessage('/nonexistent/nope.jsonl')).toBeNull();
  });
});

describe('parseEditReason', () => {
  // Claude Code writes each content block of a reply as its own line, tied by message.id.
  const block = (msgId, item, extra = {}) =>
    JSON.stringify({ type: 'assistant', ...extra, message: { id: msgId, role: 'assistant', content: [item] } });
  const tool = (id) => ({ type: 'tool_use', id, name: 'Edit', input: {} });
  const toolResult = (id) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } });

  it('uses the text blocks of the same reply that precede the tool_use', () => {
    const jsonl = [
      block('m1', { type: 'thinking', thinking: 'hmm' }),
      block('m1', { type: 'text', text: 'Debounce   the\nwatcher' }),
      block('m1', tool('t1')),
    ].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBe('Debounce the watcher');
  });

  it('falls back to the last assistant text before the reply', () => {
    const jsonl = [block('m0', { type: 'text', text: 'Plan: fix it' }), block('m1', tool('t1'))].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBe('Plan: fix it');
  });

  it('walks past tool results to find that text', () => {
    const jsonl = [
      block('m0', { type: 'text', text: 'Reading first' }),
      block('m0', tool('t0')),
      toolResult('t0'),
      block('m1', tool('t1')),
    ].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBe('Reading first');
  });

  it('never crosses a user prompt', () => {
    const jsonl = [block('m0', { type: 'text', text: 'old' }), userLine('do x'), block('m1', tool('t1'))].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBeNull();
  });

  it('ignores subagent (sidechain) text', () => {
    const jsonl = [
      block('m0', { type: 'text', text: 'main says' }),
      block('s1', { type: 'text', text: 'subagent says' }, { isSidechain: true }),
      block('m1', tool('t1')),
    ].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBe('main says');
  });

  it('is null for an unknown tool_use id', () => {
    expect(parseEditReason(block('m1', tool('t1')), 'nope')).toBeNull();
  });

  it('cuts at 200 chars with an ellipsis', () => {
    const jsonl = [block('m1', { type: 'text', text: 'x'.repeat(300) }), block('m1', tool('t1'))].join('\n');
    expect(parseEditReason(jsonl, 't1')).toBe(`${'x'.repeat(200)}…`);
  });

  it('reads it from a transcript file, null when the file is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cm-reason-'));
    const file = path.join(dir, 't.jsonl');
    await writeFile(file, [block('m1', { type: 'text', text: 'why' }), block('m1', tool('t1'))].join('\n'));
    expect(await readEditReason(file, 't1')).toBe('why');
    expect(await readEditReason(path.join(dir, 'missing.jsonl'), 't1')).toBeNull();
  });
});

describe('parseLastBashCommand (#94)', () => {
  const bash = (command, extra = {}) =>
    JSON.stringify({ type: 'assistant', ...extra, message: { id: 'm', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] } });

  it('takes the last Bash command since the prompt', () => {
    const jsonl = [userLine('faz'), bash('ls'), bash('sed -i   s/x/y/\n b.txt')].join('\n');
    expect(parseLastBashCommand(jsonl)).toBe('sed -i s/x/y/ b.txt');
  });

  it('ignores commands from before the prompt and from subagents', () => {
    expect(parseLastBashCommand([bash('antigo'), userLine('novo pedido')].join('\n'))).toBeNull();
    expect(parseLastBashCommand([userLine('p'), bash('sub', { isSidechain: true })].join('\n'))).toBeNull();
  });

  it('cuts long commands', () => {
    expect(parseLastBashCommand([userLine('p'), bash('x'.repeat(300))].join('\n'))).toBe(`${'x'.repeat(200)}…`);
  });
});
