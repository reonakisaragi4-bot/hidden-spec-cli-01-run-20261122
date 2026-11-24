// mend: the command-line tool SPEC.md specifies. Node 22, the standard library alone.
// Run as `node main.ts [options] [PATCH]` with the working directory as the root of a
// tree of text files. It reads a patch in one of four formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching
// tiers, and writes every change or none, printing what it changed or why it failed.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as the edits see it: its lines, its own break, whether it ends with one. */
interface FileModel {
  lines: string[];
  eol: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function serializeFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.finalBreak ? f.eol : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves that succeeded, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** How one line reads at a matching tier: exact, trailing whitespace off, both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where O occurs in the file's lines at one tier (occurrences may overlap). */
function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const n = o.length;
  const out: number[] = [];
  if (n === 0) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normLine(fileLines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only under --strict) at which O occurs at least once. */
function findTier(fileLines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    const occ = occurrencesAt(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * One line of N as written: a context line is the file's own matched line; at tier 2 every
 * other line is re-indented, P (the leading whitespace of O's first line) replaced by F
 * (that of the file's first matched line) where it starts with P; at tiers 0 and 1, as it is.
 */
interface NewLine {
  text: string;
  context: boolean;
  /** For a context line, its index in O (hence in the matched file lines). */
  oIndex: number | null;
}

function buildReplacement(fileLines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = fileLines.length > pos ? leadWs(fileLines[pos]!) : '';
  for (const e of n) {
    if (e.context && e.oIndex !== null) {
      out.push(fileLines[pos + e.oIndex]!);
    } else if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** The hunk's -A number. */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines, in body order, each marked as context (with its index in O) or added. */
  n: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for created files). */
  lastPlusNoEol: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab < 0 ? rest : rest.slice(0, tab)).trim().replace(/^(a|b)\//, '');
}

function parseDiffGit(line: string, lineNo: number): { old: string; nu: string } {
  const rest = line.slice('diff --git '.length).trim();
  const parts = rest.split(' ');
  if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) {
    throw new Exit2(`error: parse ${lineNo}`);
  }
  return { old: parts[0]!.slice(2), nu: parts[1]!.slice(2) };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: |$)/;

/** A hunk's body: lines from i until the first line that is not a body line. */
function hunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ') || b === '') {
      const t = b === '' ? '' : b.slice(1);
      const oi = o.length;
      o.push(t);
      n.push({ text: t, context: true, oIndex: oi });
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), context: false, oIndex: null });
    }
    // `\` lines refer to the body line before them and are otherwise ignored here.
  }
  let noEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.startsWith(' ') || b.startsWith('+') || b === '') {
      noEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  let lastPlusNoEol = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.startsWith('+')) {
      lastPlusNoEol = k + 1 < body.length && body[k + 1]!.startsWith('\\');
      break;
    }
  }
  return { a, o, n, noEol, lastPlusNoEol };
}

/**
 * One section, from `start` (the line after a `diff --git` line, or the `--- ` line that
 * starts it) to just past its last hunk. Returns the next line index to examine.
 */
function parseSection(lines: string[], start: number, section: Section): number {
  let i = start;
  let inHeader = true;
  let sawPair = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffOld: string | null = section.oldPath;
  let diffNew: string | null = section.newPath;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        if (inHeader && !sawPair) {
          section.oldPath = headerPath(line);
          section.newPath = headerPath(lines[i + 1]!);
          sawPair = true;
          i += 2;
          continue;
        }
        break;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = hunkBody(lines, i + 1);
      section.hunks.push(buildHunk(Number(m[1]), body));
      inHeader = false;
      i = next;
      continue;
    }
    if (inHeader) {
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) section.creation = true;
      else if (line.startsWith('deleted file mode')) section.deletion = true;
      i++;
      continue;
    }
    i++;
  }
  if (!sawPair) {
    if (renameFrom !== null) section.oldPath = renameFrom;
    else if (section.oldPath === null) section.oldPath = diffOld;
    if (renameTo !== null) section.newPath = renameTo;
    else if (section.newPath === null) section.newPath = diffNew;
  }
  if (section.oldPath === '/dev/null') section.oldPath = null;
  if (section.newPath === '/dev/null') section.newPath = null;
  return i;
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dp = parseDiffGit(line, i + 1);
      const section: Section = { oldPath: dp.old, newPath: dp.nu, creation: false, deletion: false, hunks: [] };
      i = parseSection(lines, i + 1, section);
      edits.push(unifiedEdit(section));
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      const section: Section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
      i = parseSection(lines, i, section);
      edits.push(unifiedEdit(section));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply a section's hunks in order to a file model; `d` tracks the length drift so far. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(model.lines, h.o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const oldLen = model.lines.length;
      const repl = buildReplacement(model.lines, pos, h.o, h.n, found.tier);
      model.lines.splice(pos, h.o.length, ...repl);
      if (pos + h.o.length === oldLen) model.finalBreak = !h.noEol;
      d += h.n.length - h.o.length;
    } else {
      const oldLen = model.lines.length;
      const idx = Math.min(Math.max(0, h.a + d), oldLen);
      const ins = h.n.map((e) => e.text);
      model.lines.splice(idx, 0, ...ins);
      if (idx === oldLen) model.finalBreak = !h.noEol;
      d += h.n.length;
    }
  }
}

function unifiedEdit(section: Section): Edit {
  return (tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreation = oldP === null || section.creation;
    const isDeletion = !isCreation && (newP === null || section.deletion);
    if (isCreation && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of section.hunks) for (const e of h.n) if (!e.context) plus.push(e.text);
      let noEol = false;
      outer: for (let hi = section.hunks.length - 1; hi >= 0; hi--) {
        const h = section.hunks[hi]!;
        for (let k = h.n.length - 1; k >= 0; k--) {
          if (!h.n[k]!.context) {
            noEol = h.lastPlusNoEol;
            break outer;
          }
        }
      }
      const file: FileModel = { lines: plus, eol: '\n', finalBreak: !noEol };
      tree.now.set(newP, serializeFile(file));
      return;
    }
    if (isDeletion && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = parseFile(before);
      applyHunks(model, section.hunks, currentStrict, oldP);
      tree.now.set(newP, serializeFile(model));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP;
    if (p === null) return;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const model = parseFile(before);
    applyHunks(model, section.hunks, currentStrict, p);
    tree.now.set(p, serializeFile(model));
  };
}

// --strict is a run-wide flag; edits read it here so the parsers stay pure.
let currentStrict = false;

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const file: FileModel = { lines: [...newLines], eol: '\n', finalBreak: true };
      tree.now.set(path, serializeFile(file));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, currentStrict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NewLine[] = newLines.map((t) => ({ text: t, context: false, oIndex: null }));
    const repl = buildReplacement(model.lines, pos, oldLines, n, found.tier);
    model.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, serializeFile(model));
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchNo = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchNo}`);
    prevPath = path;
    edits.push(srEdit(path, oldLines, newLines));
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  /** Null: no anchor. */
  anchor: string | null;
  o: string[];
  n: NewLine[];
  /** Anchored to the end of the file. */
  eof: boolean;
}

function stripTrailingBlanks(ls: string[]): string[] {
  let end = ls.length;
  while (end > 0 && blank(ls[end - 1]!)) end--;
  return ls.slice(0, end);
}

const V4A_SECTION = /^\*\*\* (Add File|Delete File|Update File): /;

/** Section content: lines from `start` until the next section header or `end` (exclusive). */
function v4aSectionLines(lines: string[], start: number, end: number): { content: string[]; next: number } {
  let i = start;
  while (i < end) {
    const l = lines[i]!;
    if (V4A_SECTION.test(l)) break;
    i++;
  }
  return { content: lines.slice(start, i), next: i };
}

/** One chunk's body: body lines from `j` until `@@`, `*** End of File` or the end. */
function v4aChunkBody(content: string[], j: number): { body: string[]; eof: boolean; next: number } {
  const body: string[] = [];
  let eof = false;
  while (j < content.length) {
    const l = content[j]!;
    if (l.startsWith('@@')) break;
    if (l.trim() === '*** End of File') {
      eof = true;
      j++;
      break;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  return { body, eof, next: j };
}

function v4aChunkFromBody(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ') || b === '') {
      const t = b === '' ? '' : b.slice(1);
      const oi = o.length;
      o.push(t);
      n.push({ text: t, context: true, oIndex: oi });
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), context: false, oIndex: null });
    }
  }
  return { o, n };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const file: FileModel = { lines: [...fileLines], eol: '\n', finalBreak: true };
    tree.now.set(path, serializeFile(file));
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(model.lines, [chunk.anchor], currentStrict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (chunk.o.length > 0) {
        const found = findTier(model.lines, chunk.o, currentStrict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos = found.occ[0]!;
        if (chunk.eof) {
          const atEnd = found.occ.find((q) => q + chunk.o.length === model.lines.length);
          if (atEnd === undefined) throw new Fail('no-match', path);
          pos = atEnd;
        }
        const repl = buildReplacement(model.lines, pos, chunk.o, chunk.n, found.tier);
        model.lines.splice(pos, chunk.o.length, ...repl);
        cursor = pos + repl.length;
      } else {
        const idx = chunk.eof ? model.lines.length : cursor;
        const ins = chunk.n.map((e) => e.text);
        model.lines.splice(idx, 0, ...ins);
        cursor = idx + ins.length;
      }
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, serializeFile(model));
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, serializeFile(model));
    }
  };
}

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const { content, next } = v4aSectionLines(lines, i + 1, last);
      const trimmed = stripTrailingBlanks(content);
      for (let k = 0; k < trimmed.length; k++) {
        const l = trimmed[k]!;
        if (!(l.startsWith('+') || l === '')) throw new Exit2(`error: parse ${i + 2 + k}`);
      }
      const fileLines = trimmed.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const { content, next } = v4aSectionLines(lines, i + 1, last);
      const trimmed = stripTrailingBlanks(content);
      const bad = trimmed.findIndex((l) => l !== '');
      if (bad >= 0) throw new Exit2(`error: parse ${i + 2 + bad}`);
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateNo = i + 1;
      const { content, next } = v4aSectionLines(lines, i + 1, last);
      const trimmed = stripTrailingBlanks(content);
      let j = 0;
      let moveTo: string | null = null;
      if (trimmed.length > 0 && trimmed[0]!.startsWith('*** Move to: ')) {
        moveTo = trimmed[0]!.slice('*** Move to: '.length).trim();
        j = 1;
      }
      const chunks: V4aChunk[] = [];
      while (j < trimmed.length) {
        const l = trimmed[j]!;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          const anchor = anchorText === '' ? null : anchorText;
          const { body, eof, next: nj } = v4aChunkBody(trimmed, j + 1);
          const { o, n } = v4aChunkFromBody(body);
          chunks.push({ anchor, o, n, eof });
          j = nj;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (chunks.length > 0) throw new Exit2(`error: parse ${i + 2 + j}`);
          const { body, eof, next: nj } = v4aChunkBody(trimmed, j);
          const { o, n } = v4aChunkFromBody(body);
          chunks.push({ anchor: null, o, n, eof });
          j = nj;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2 + j}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---- Invocation, output and exit codes (SPEC.md sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  currentStrict = strict;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines);
    else edits = parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, nw] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.get(o);
    const wasN = tree.original(nw);
    const nowN = tree.now.get(nw);
    if (wasO !== null && nowO === null && wasN === null && nowN !== null) {
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      movedOld.add(o);
      movedNew.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
