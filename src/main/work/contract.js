// The task plan beyond the checklist: the contract (2-6 acceptance cases the
// dev owns), the test files and command, each step's why and the [dev] steps.
// A plan without "## Contrato" is a quick task. Pure.
import { CHECK_LINE, MAX_STEPS, MAX_TEXT, stepLines } from './plan.js';
import { parsePlan } from '../graph/impact.js';

export const MIN_CASES = 2;
export const MAX_CASES = 6;
export const MAX_DEV_STEPS = 2;
export const MAX_WHY = 300;
export const MAX_COMMAND = 200;

const CONTRACT_HEADING = /^##\s+Contrato\s*$/i;
// Top-level bullets only: an indented sub-bullet is a note on its case, not a case.
const ITEM_LINE = /^[-*+]\s+(?!\[[ xX]\]\s)(.+?)\s*$/;
const CONTRACT_LIKE = /^#{1,6}\s+contratos?\b/i;
const MALFORMED = 'O contrato está malformado (use `## Contrato` e itens `- situação → resultado`).';
const FILES_LINE = /^[ \t>*-]*`?Vizor-contrato:`?[ \t]*(.*)$/im;
const TEST_LINE = /^[ \t>*-]*`?Vizor-teste:`?[ \t]*(.*)$/im;
const WHY_LINE = /^\s+porqu[êe]:\s*(.+?)\s*$/i;
const DEV_TAG = /^\[dev\]\s*/i;
const TODO_DEV = /TODO\(dev\):\s*(.*?)\s*$/;

const unquote = (text) => text.trim().replace(/^`+|`+$/g, '').trim();

function contractCases(lines) {
  const start = lines.findIndex((line) => CONTRACT_HEADING.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((line) => line.match(ITEM_LINE)?.[1])
    .filter(Boolean)
    .map((text) => ({ text }));
}

// Test files stay relative to the session's folder: no absolute path, no "..".
function contractFiles(lines) {
  const found = lines.filter((line) => FILES_LINE.test(line));
  if (found.length > 1) return { files: [], error: 'Há mais de uma linha Vizor-contrato.' };
  const raw = found[0]?.match(FILES_LINE)[1] ?? '';
  const files = [];
  for (const piece of raw.split(',')) {
    const file = unquote(piece);
    if (!file) continue;
    if (file.includes('\0') || file.startsWith('/') || file.startsWith('~') || /^[a-zA-Z]:[\\/]/.test(file) || file.split(/[\\/]/).includes('..')) {
      return { files: [], error: `Arquivo de teste fora da pasta do projeto: ${file}.` };
    }
    files.push(file);
  }
  return { files, error: null };
}

// One line, short: the dev approves this exact text and the Vizor runs it.
function testCommand(lines) {
  const index = lines.findIndex((line) => TEST_LINE.test(line));
  if (lines.filter((line) => TEST_LINE.test(line)).length > 1) return { command: null, error: 'Há mais de uma linha Vizor-teste.' };
  if (index < 0) return { command: null, error: null };
  const command = unquote(lines[index].match(TEST_LINE)[1]);
  const continued = command.endsWith('\\') || /^[ \t]+\S/.test(lines[index + 1] ?? '');
  if (continued) return { command: null, error: 'O comando de teste deve caber em uma linha só.' };
  if (command.length > MAX_COMMAND) return { command: null, error: `O comando de teste passa de ${MAX_COMMAND} caracteres.` };
  return { command: command || null, error: null };
}

function planSteps(markdown) {
  const lines = stepLines(markdown);
  const steps = [];
  for (let i = 0; i < lines.length && steps.length < MAX_STEPS; i++) {
    const match = lines[i].match(CHECK_LINE);
    if (!match) continue;
    const text = match[2].slice(0, MAX_TEXT);
    const dev = DEV_TAG.test(text);
    const why = lines[i + 1]?.match(WHY_LINE)?.[1] ?? null;
    steps.push({ text: dev ? text.replace(DEV_TAG, '') : text, done: match[1] !== ' ', why: why && why.slice(0, MAX_WHY), dev });
  }
  return steps;
}

export function parseTaskPlan(markdown) {
  const text = String(markdown ?? '');
  const lines = text.split('\n');
  const contract = contractCases(lines);
  const files = contractFiles(lines);
  const command = testCommand(lines);
  const steps = planSteps(text);
  let error = null;
  if (contract && (contract.length < MIN_CASES || contract.length > MAX_CASES)) {
    error = `O contrato precisa de ${MIN_CASES} a ${MAX_CASES} casos (achei ${contract.length}).`;
  }
  // Anything that looks like a contract but did not parse must not pass as a quick task.
  if (!contract && (lines.some((line) => CONTRACT_LIKE.test(line)) || lines.some((line) => FILES_LINE.test(line) || TEST_LINE.test(line)))) {
    error = MALFORMED;
  }
  error ??= files.error ?? command.error;
  if (!error && steps.filter((step) => step.dev).length > MAX_DEV_STEPS) {
    error = `No máximo ${MAX_DEV_STEPS} passos [dev] por tarefa.`;
  }
  return {
    title: lines.find((line) => /^#\s/.test(line))?.replace(/^#\s+/, '').trim() ?? '',
    contract,
    contractFiles: files.files,
    testCommand: command.command,
    steps,
    planned: parsePlan(text, '/vizor-root'),
    error,
  };
}

// The scaffold the músico leaves where the dev's logic goes.
export function findDevTodos(text) {
  const todos = [];
  String(text ?? '').split('\n').forEach((line, index) => {
    const match = line.match(TODO_DEV);
    if (match) todos.push({ line: index + 1, note: match[1] });
  });
  return todos;
}
