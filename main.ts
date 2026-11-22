// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function splitFile(text: string | null): { lines: string[]; crlf: boolean; eol: boolean } {
  if (text === null || text === '') return { lines: [], crlf: false, eol: false };
  const crlf = text.includes('\r\n');
  const eol = text.endsWith('\n') || text.endsWith('\r\n');
  const norm = crlf ? text.replace(/\r\n/g, '\n') : text;
  const body = eol ? norm.slice(0, -1) : norm;
  const lines = body === '' ? [] : body.split('\n');
  return { lines, crlf, eol };
}

function joinFile(lines: string[], crlf: boolean, eol: boolean): string {
  if (lines.length === 0 && !eol) return '';
  let t = lines.join('\n');
  if (eol) t += '\n';
  if (crlf) t = t.replace(/\n/g, '\r\n');
  return t;
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// --- Section 5: tiered line matching ---

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trimTrailing = (s: string) => s.replace(/[ \t]+$/, '');
  const trimBoth = (s: string) => s.trim();
  if (tier === 1) return trimTrailing(a) === trimTrailing(b);
  return trimBoth(a) === trimBoth(b);
}

function findOccurrences(T: string[], O: string[], tier: number): number[] {
  if (O.length === 0) return [];
  const idxs: number[] = [];
  for (let i = 0; i <= T.length - O.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEqual(T[i + j], O[j], tier)) { ok = false; break; }
    }
    if (ok) idxs.push(i);
  }
  return idxs;
}

function pickOccurrence(T: string[], O: string[], target: number, strict: boolean): number | null {
  if (O.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = findOccurrences(T, O, tier);
    if (occ.length > 0) {
      let best = occ[0];
      let bestDist = Math.abs(occ[0] - target);
      for (const i of occ) {
        const d = Math.abs(i - target);
        if (d < bestDist || (d === bestDist && i < best)) { best = i; bestDist = d; }
      }
      return best;
    }
  }
  return null;
}

function countAtFirstTier(T: string[], O: string[], strict: boolean): { tier: number; count: number } {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = findOccurrences(T, O, tier);
    if (occ.length > 0) return { tier, count: occ.length };
  }
  return { tier: 0, count: 0 };
}

function reindentTier2(N: string[], P_lines: string[], F_line: string): string[] {
  const P_lead = P_lines[0]?.match(/^[ \t]*/)?.[0] ?? '';
  const F_lead = F_line.match(/^[ \t]*/)?.[0] ?? '';
  if (P_lead === '') return N;
  return N.map((line) => {
    if (line === '' || line.trim() === '') return line;
    if (line.startsWith(P_lead)) return F_lead + line.slice(P_lead.length);
    return line;
  });
}

// --- Section 6: unified diff ---

interface UnifiedSection {
  oldPath: string;
  newPath: string;
  isCreate: boolean;
  isDelete: boolean;
  isMove: boolean;
  hunks: UnifiedHunk[];
  startLine: number;
}

interface UnifiedHunk {
  A: number;
  B: number;
  C: number;
  D: number;
  O: string[];
  N: string[];
  body: string[];
  hasNoNewline: boolean;
  startLine: number;
}

function parseUnified(text: string, lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  const n = lines.length;

  const parseHunkHeader = (line: string): { A: number; B: number; C: number; D: number } | null => {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) return null;
    return { A: parseInt(m[1]), B: parseInt(m[2] ?? '1'), C: parseInt(m[3]), D: parseInt(m[4] ?? '1') };
  };

  const isDevNull = (p: string) => p === '/dev/null';

  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      let oldPath = m[1];
      let newPath = m[2];
      i++;
      let renameFrom: string | null = null;
      let renameTo: string | null = null;
      let newFileMode = false;
      let deletedFileMode = false;
      while (i < n) {
        const l = lines[i];
        if (l.startsWith('--- ')) {
          const p = l.slice(4).split('\t')[0].trim();
          if (!isDevNull(p)) oldPath = p.replace(/^a\//, '');
        } else if (l.startsWith('+++ ')) {
          const p = l.slice(4).split('\t')[0].trim();
          if (!isDevNull(p)) newPath = p.replace(/^b\//, '');
        } else if (l.startsWith('rename from ')) {
          renameFrom = l.slice(12).trim();
        } else if (l.startsWith('rename to ')) {
          renameTo = l.slice(10).trim();
        } else if (l === 'new file mode 100644') {
          newFileMode = true;
        } else if (l === 'deleted file mode 100644') {
          deletedFileMode = true;
        } else if (l.startsWith('index ') || l.startsWith('old mode ') || l.startsWith('new mode ') || l.startsWith('similarity index ')) {
          // ignore
        } else {
          break;
        }
        i++;
      }
      if (renameFrom) oldPath = renameFrom;
      if (renameTo) newPath = renameTo;
      const hunks: UnifiedHunk[] = [];
      while (i < n) {
        const l = lines[i];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
        if (l.startsWith('@@ ')) {
          const hdr = parseHunkHeader(l);
          if (!hdr) throw new Exit2(`error: parse ${i + 1}`);
          const hunkStart = i + 1;
          i++;
          const body: string[] = [];
          while (i < n) {
            const bl = lines[i];
            if (bl.startsWith('diff --git ')) break;
            if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
            if (bl.startsWith('@@ ')) break;
            if (bl.startsWith('\\')) { body.push(bl); }
            else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) { body.push(bl); }
            else break;
            i++;
          }
          while (body.length > 0 && body[body.length - 1] === '') body.pop();
          const O: string[] = [];
          const N: string[] = [];
          let hasNoNewline = false;
          for (let bi = 0; bi < body.length; bi++) {
            const bl = body[bi];
            if (bl.startsWith('\\')) {
              if (bi > 0) {
                const prev = body[bi - 1];
                if (prev.startsWith(' ') || prev.startsWith('+')) hasNoNewline = true;
              }
              continue;
            }
            if (bl === '') { O.push(''); N.push(''); continue; }
            if (bl.startsWith(' ') || bl.startsWith('-')) O.push(bl.slice(1));
            if (bl.startsWith(' ') || bl.startsWith('+')) N.push(bl.slice(1));
          }
          hunks.push({ ...hdr, O, N, body, hasNoNewline, startLine: hunkStart });
        } else if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          i += 2;
        } else {
          i++;
        }
      }
      const isCreate = isDevNull(oldPath) || newFileMode;
      const isDelete = isDevNull(newPath) || deletedFileMode;
      const isMove = oldPath !== newPath && !isCreate && !isDelete;
      sections.push({ oldPath, newPath, isCreate, isDelete, isMove, hunks, startLine: i - hunks.length });
    } else if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      const oldP = lines[i].slice(4).split('\t')[0].trim();
      const newP = lines[i + 1].slice(4).split('\t')[0].trim();
      const oldPath = isDevNull(oldP) ? '/dev/null' : oldP.replace(/^a\//, '');
      const newPath = isDevNull(newP) ? '/dev/null' : newP.replace(/^b\//, '');
      i += 2;
      const hunks: UnifiedHunk[] = [];
      while (i < n) {
        const l = lines[i];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('@@ ')) {
          const hdr = parseHunkHeader(l);
          if (!hdr) throw new Exit2(`error: parse ${i + 1}`);
          const hunkStart = i + 1;
          i++;
          const body: string[] = [];
          while (i < n) {
            const bl = lines[i];
            if (bl.startsWith('diff --git ')) break;
            if (bl.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) break;
            if (bl.startsWith('@@ ')) break;
            if (bl.startsWith('\\')) { body.push(bl); }
            else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) { body.push(bl); }
            else break;
            i++;
          }
          while (body.length > 0 && body[body.length - 1] === '') body.pop();
          const O: string[] = [];
          const N: string[] = [];
          let hasNoNewline = false;
          for (let bi = 0; bi < body.length; bi++) {
            const bl = body[bi];
            if (bl.startsWith('\\')) {
              if (bi > 0) {
                const prev = body[bi - 1];
                if (prev.startsWith(' ') || prev.startsWith('+')) hasNoNewline = true;
              }
              continue;
            }
            if (bl === '' || bl.startsWith(' ') || bl.startsWith('-')) O.push(bl === '' ? '' : bl.slice(1));
            if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) N.push(bl === '' ? '' : bl.slice(1));
          }
          hunks.push({ ...hdr, O, N, body, hasNoNewline, startLine: hunkStart });
        } else if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          break;
        } else {
          i++;
        }
      }
      const isCreate = isDevNull(oldPath);
      const isDelete = isDevNull(newPath);
      const isMove = oldPath !== newPath && !isCreate && !isDelete;
      sections.push({ oldPath, newPath, isCreate, isDelete, isMove, hunks, startLine: i - hunks.length });
    } else if (line.startsWith('@@ ')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  return sections;
}

function readUnified(text: string, lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(text, lines);
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldPath = sec.oldPath === '/dev/null' ? null : sec.oldPath;
    const newPath = sec.newPath === '/dev/null' ? null : sec.newPath;
    if (!sec.isCreate && oldPath && !safe(oldPath)) {
      edits.push((tree) => { throw new Fail('unsafe', oldPath); });
      continue;
    }
    if (newPath && !safe(newPath)) {
      edits.push((tree) => { throw new Fail('unsafe', newPath); });
      continue;
    }
    if (sec.isCreate) {
      edits.push((tree) => {
        if (!newPath) throw new Fail('unsafe', '(create)');
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const newLines: string[] = [];
        for (const h of sec.hunks) newLines.push(...h.N);
        const lastHunk = sec.hunks[sec.hunks.length - 1];
        const eol = !lastHunk.hasNoNewline;
        const crlf = false;
        const content = joinFile(newLines, crlf, eol);
        tree.now.set(newPath, content);
      });
    } else if (sec.isDelete) {
      edits.push((tree) => {
        if (!oldPath) throw new Fail('unsafe', '(delete)');
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      });
    } else if (sec.isMove) {
      edits.push(makeMoveEdit(oldPath!, newPath!, sec.hunks, strict));
    } else {
      const path = oldPath || newPath;
      if (!path) continue;
      edits.push(makeChangeEdit(path, sec.hunks, strict));
    }
  }
  return edits;
}

function makeMoveEdit(oldPath: string, newPath: string, hunks: UnifiedHunk[], strict: boolean): Edit {
  explicitMoves.push([oldPath, newPath]);
  return (tree) => {
    const content = tree.get(oldPath);
    if (content === null) throw new Fail('missing', oldPath);
    if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let { lines: curLines, crlf, eol } = splitFile(content);
    let d = 0;
    for (const h of hunks) {
      const target = h.A - 1 + d;
      if (h.O.length === 0) {
        const insertAt = Math.min(h.A + d, curLines.length);
        curLines.splice(insertAt, 0, ...h.N);
        d += h.N.length;
        if (insertAt >= curLines.length - h.N.length) {
          eol = !h.hasNoNewline;
        }
      } else {
        const match = pickOccurrence(curLines, h.O, target, strict);
        if (match === null) throw new Fail('no-match', newPath);
        // NOTE: unified diffs do NOT throw on ambiguity; they pick nearest
        const { count } = countAtFirstTier(curLines, h.O, strict);
        // Only throw ambiguous for SEARCH/REPLACE, not unified
        const beforeLen = curLines.length;
        const F_line = curLines[match];
        const reindentedN = reindentTier2(h.N, h.O, F_line);
        const atEnd = (match + h.O.length === beforeLen);
        curLines = applyHunkBody(curLines, match, h.body, reindentedN, h.O, h.N);
        d += h.N.length - h.O.length;
        if (atEnd) eol = !h.hasNoNewline;
      }
    }
    tree.now.set(oldPath, null);
    tree.now.set(newPath, joinFile(curLines, crlf, eol));
  };
}

function makeChangeEdit(path: string, hunks: UnifiedHunk[], strict: boolean): Edit {
  return (tree) => {
    if (tree.get(path) === null) throw new Fail('missing', path);
    const content = tree.get(path)!;
    let { lines: curLines, crlf, eol } = splitFile(content);
    let d = 0;
    for (const h of hunks) {
      const target = h.A - 1 + d;
      if (h.O.length === 0) {
        const insertAt = Math.min(h.A + d, curLines.length);
        curLines.splice(insertAt, 0, ...h.N);
        d += h.N.length;
        if (insertAt >= curLines.length - h.N.length) {
          eol = !h.hasNoNewline;
        }
      } else {
        const match = pickOccurrence(curLines, h.O, target, strict);
        if (match === null) throw new Fail('no-match', path);
        // NOTE: unified diffs do NOT throw on ambiguity; they pick nearest
        const beforeLen = curLines.length;
        const F_line = curLines[match];
        const reindentedN = reindentTier2(h.N, h.O, F_line);
        const atEnd = (match + h.O.length === beforeLen);
        curLines = applyHunkBody(curLines, match, h.body, reindentedN, h.O, h.N);
        d += h.N.length - h.O.length;
        if (atEnd) eol = !h.hasNoNewline;
      }
    }
    tree.now.set(path, joinFile(curLines, crlf, eol));
  };
}

function applyHunkBody(
  curLines: string[],
  match: number,
  body: string[],
  reindentedN: string[],
  O: string[],
  N: string[]
): string[] {
  const result: string[] = [];
  result.push(...curLines.slice(0, match));
  let fileIdx = match;
  let nIdx = 0;
  let oIdx = 0;

  for (const bl of body) {
    if (bl.startsWith('\\')) continue;
    if (bl === '' || bl.startsWith(' ')) {
      if (fileIdx < curLines.length) {
        result.push(curLines[fileIdx]);
        fileIdx++;
        oIdx++;
        nIdx++;
      }
    } else if (bl.startsWith('-')) {
      fileIdx++;
      oIdx++;
    } else if (bl.startsWith('+')) {
      if (nIdx < reindentedN.length) {
        result.push(reindentedN[nIdx]);
        nIdx++;
      }
    }
  }
  result.push(...curLines.slice(fileIdx));
  return result;
}

// --- Section 7: SEARCH/REPLACE ---

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
  startLine: number;
}

function parseSearchReplace(text: string, lines: string[]): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  let lastReplaceEnd = -1;
  let lastPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j > lastReplaceEnd; j--) {
        const pl = lines[j].trim();
        if (pl !== '' && !pl.startsWith('```')) { path = pl; break; }
      }
      if (path === null) {
        if (lastPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = lastPath;
      }
      lastPath = path;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '=======') { eq = j; break; }
      }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let end = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j].trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
      if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
      const oldLines: string[] = [];
      for (let j = i + 1; j < eq; j++) oldLines.push(lines[j]);
      const newLines: string[] = [];
      for (let j = eq + 1; j < end; j++) newLines.push(lines[j]);
      blocks.push({ path: path!, oldLines, newLines, startLine: i + 1 });
      lastReplaceEnd = end;
    }
  }
  return blocks;
}

function readSearchReplace(text: string, lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(text, lines);
  const edits: Edit[] = [];
  for (const b of blocks) {
    if (!safe(b.path)) {
      edits.push((tree) => { throw new Fail('unsafe', b.path); });
      continue;
    }
    if (b.oldLines.length === 0) {
      edits.push((tree) => {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.join('\n') + '\n');
      });
    } else {
      edits.push((tree) => {
        const content = tree.get(b.path);
        if (content === null) throw new Fail('missing', b.path);
        let { lines: fileLines, crlf, eol } = splitFile(content);
        const { tier, count } = countAtFirstTier(fileLines, b.oldLines, strict);
        if (count === 0) throw new Fail('no-match', b.path);
        if (count > 1) throw new Fail('ambiguous', b.path);
        const occ = findOccurrences(fileLines, b.oldLines, tier);
        const match = occ[0];
        const F_line = fileLines[match];
        const reindentedNew = tier === 2 ? reindentTier2(b.newLines, b.oldLines, F_line) : b.newLines;
        fileLines.splice(match, b.oldLines.length, ...reindentedNew);
        tree.now.set(b.path, joinFile(fileLines, crlf, eol));
      });
    }
  }
  return edits;
}

// --- Section 8: V4A ---

interface V4AChunk {
  oldLines: string[];
  newLines: string[];
  body: string[];  // raw body lines with prefixes: ' ', '-', '+', '\\'
  anchor: string | null;
  isEof: boolean;
  startLine: number;
}

interface V4ASection {
  type: 'update' | 'add' | 'delete' | 'move';
  oldPath: string | null;
  newPath: string | null;
  chunks: V4AChunk[];
  moveTo: string | null;
  startLine: number;
}

function parseV4ASections(text: string, lines: string[]): V4ASection[] {
  if (lines.length === 0 || lines[0].trim() !== '*** Begin Patch') {
    throw new Exit2('error: parse 1');
  }
  const sections: V4ASection[] = [];
  let i = 1;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '*** End Patch') break;
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      let moveTo: string | null = null;
      if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
        moveTo = lines[i].slice(13).trim();
        if (!safe(moveTo)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      const chunks: V4AChunk[] = [];
      while (i < lines.length) {
        if (lines[i].startsWith('*** ')) break;
        let anchor: string | null = null;
        let isEof = false;
        const oldLines: string[] = [];
        const newLines: string[] = [];
        const chunkStart = i;
        if (i < lines.length && lines[i].startsWith('@@')) {
          anchor = lines[i].slice(2).trim();
          i++;
        }
        let hadChange = false;
        const body: string[] = [];
        while (i < lines.length) {
          const cl = lines[i];
          if (cl.startsWith('*** ')) break;
          if (cl === '') { oldLines.push(''); newLines.push(''); body.push('\\\\'); i++; continue; }
          if (cl.startsWith(' ')) { oldLines.push(cl.slice(1)); newLines.push(cl.slice(1)); body.push(cl); i++; continue; }
          if (cl.startsWith('-')) { oldLines.push(cl.slice(1)); newLines.push(cl.slice(1)); body.push(cl); hadChange = true; i++; continue; }
          if (cl.startsWith('+')) { newLines.push(cl.slice(1)); body.push(cl); hadChange = true; i++; continue; }
          break;
        }
        // Trim trailing empty context lines from body (patch separator, not required in file)
        while (body.length > 0) {
          const last = body[body.length - 1];
          const isTrailingEmpty = (last === '\\\\' || last === ' ');
          if (!isTrailingEmpty) break;
          body.pop();
          oldLines.pop();
          newLines.pop();
        }
        if (i < lines.length && lines[i].trim() === '*** End of File') {
          isEof = true;
          i++;
        }
        if (!hadChange && !isEof) {
          throw new Exit2(`error: parse ${chunkStart + 1}`);
        }
        chunks.push({ oldLines, newLines, anchor, isEof, startLine: chunkStart + 1, body });
      }
      sections.push({ type: 'update', oldPath: path, newPath: moveTo ?? path, chunks, moveTo, startLine: i - 1 });
    } else if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const newLines: string[] = [];
      while (i < lines.length) {
        const cl = lines[i];
        if (cl.startsWith('*** ')) break;
        if (cl === '') { newLines.push(''); i++; continue; }
        if (cl.startsWith('+')) { newLines.push(cl.slice(1)); i++; continue; }
        if (cl.startsWith(' ')) { newLines.push(cl.slice(1)); i++; continue; }
        break;
      }
      sections.push({ type: 'add', oldPath: null, newPath: path, chunks: [{ oldLines: [], newLines, anchor: null, isEof: false, startLine: i - newLines.length, body: newLines.map((l) => '+' + l) }], moveTo: null, startLine: i });
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      if (!safe(path)) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      sections.push({ type: 'delete', oldPath: path, newPath: null, chunks: [], moveTo: null, startLine: i });
    } else if (l.startsWith('*** Move to: ')) {
      const rest = l.slice(13).trim();
      const m = rest.match(/^(.+) -> (.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const oldPath = m[1].trim();
      const newPath = m[2].trim();
      if (!safe(oldPath) || !safe(newPath)) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      sections.push({ type: 'move', oldPath, newPath, chunks: [], moveTo: null, startLine: i });
    } else {
      i++;
    }
  }
  if (i >= lines.length) throw new Exit2(`error: parse ${lines.length + 1}`);
  return sections;
}

function readV4A(text: string, lines: string[], strict: boolean): Edit[] {
  const sections = parseV4ASections(text, lines);
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.type === 'add') {
      const addContent = sec.chunks[0]?.newLines.join('\n') + '\n' ?? '\n';
      edits.push((tree) => {
        if (!sec.newPath) return;
        if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
        tree.now.set(sec.newPath, addContent);
      });
    } else if (sec.type === 'delete') {
      edits.push((tree) => {
        if (!sec.oldPath) return;
        if (tree.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
        tree.now.set(sec.oldPath, null);
      });
    } else if (sec.type === 'move') {
      if (sec.oldPath && sec.newPath) explicitMoves.push([sec.oldPath, sec.newPath]);
      edits.push((tree) => {
        if (!sec.oldPath || !sec.newPath) return;
        if (tree.get(sec.oldPath) === null) throw new Fail('missing', sec.oldPath);
        if (tree.get(sec.newPath) !== null) throw new Fail('exists', sec.newPath);
        const content = tree.get(sec.oldPath)!;
        tree.now.set(sec.oldPath, null);
        tree.now.set(sec.newPath, content);
      });
    } else if (sec.type === 'update') {
      edits.push(makeV4AUpdateEdit(sec, strict));
    }
  }
  return edits;
}

function makeV4AUpdateEdit(sec: V4ASection, strict: boolean): Edit {
  return (tree) => {
    if (!sec.oldPath) return;
    const content = tree.get(sec.oldPath);
    if (content === null) throw new Fail('missing', sec.oldPath);
    if (sec.moveTo && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    if (sec.moveTo) explicitMoves.push([sec.oldPath!, sec.moveTo]);
    let { lines: fileLines, crlf, eol } = splitFile(content);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      // Handle anchor - skip if not found (non-fatal for cursor)
      if (chunk.anchor !== null) {
        let anchorMatch: number | null = null;
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier; tier++) {
          const occ = findOccurrences(fileLines, [chunk.anchor], tier);
          const afterCursor = occ.filter(o => o >= cursor);
          if (afterCursor.length === 1) {
            anchorMatch = afterCursor[0];
            break;
          }
        }
        if (anchorMatch !== null) {
          cursor = anchorMatch + 1;
        }
      }
      // Match chunk body using body-based approach
      if (chunk.body.length === 0) {
        const at = chunk.isEof ? fileLines.length : Math.min(cursor, fileLines.length);
        fileLines.splice(at, 0, ...chunk.newLines);
        cursor = at + chunk.newLines.length;
      } else {
        let match: number | null = null;
        let matchedTier = 0;
        const maxTier = strict ? 0 : 2;
        const bodyLines = chunk.oldLines;
        for (let tier = 0; tier <= maxTier; tier++) {
          const occ = findOccurrences(fileLines, bodyLines, tier);
          const afterCursor = occ.filter(o => o >= cursor);
          if (afterCursor.length > 0) {
            match = afterCursor[0];
            matchedTier = tier;
            break;
          }
        }
        if (match === null && chunk.isEof) {
          for (let tier = 0; tier <= maxTier; tier++) {
            const occ = findOccurrences(fileLines, bodyLines, tier);
            for (const o of occ) {
              if (o + bodyLines.length === fileLines.length) {
                match = o;
                matchedTier = tier;
                break;
              }
            }
            if (match !== null) break;
          }
        }
        if (match === null) {
          // Try matching with no cursor constraint
          for (let tier = 0; tier <= maxTier; tier++) {
            const occ = findOccurrences(fileLines, bodyLines, tier);
            if (occ.length === 1) {
              match = occ[0];
              matchedTier = tier;
              break;
            }
          }
        }
        if (match === null) throw new Fail('no-match', sec.oldPath);
        // Apply using body-based approach (like unified diff applyHunkBody)
        let fileIdx = match;
        let bIdx = 0;
        const replacement: string[] = [];
        let lastContextLine: string | undefined = undefined;
        while (bIdx < chunk.body.length) {
          const bl = chunk.body[bIdx];
          if (bl.startsWith(' ')) {
            replacement.push(fileLines[fileIdx]);
            lastContextLine = fileLines[fileIdx];
            fileIdx++;
            bIdx++;
          } else if (bl.startsWith('-')) {
            // Remove line - skip file line, don't add to output
            fileIdx++;
            bIdx++;
          } else if (bl.startsWith('+')) {
            // Add line - use patch content with reindentation if tier 2
            const patchLine = bl.slice(1);
            const outLine = matchedTier === 2 ? reindentAdd(patchLine, lastContextLine ?? fileLines[match]) : patchLine;
            replacement.push(outLine);
            bIdx++;
          } else {
            // '\\' (was empty line) - treat as context
            replacement.push(fileLines[fileIdx]);
            fileIdx++;
            bIdx++;
          }
        }
        // Remove consumed file lines, insert replacement
        const removedCount = match + replacement.length - match; // = replacement.length
        // But we need to account for removed lines (- lines consume file lines but not output)
        // Count how many file lines were consumed
        let consumed = 0;
        for (let bIdx = 0; bIdx < chunk.body.length; bIdx++) {
          const bl = chunk.body[bIdx];
          if (bl.startsWith(' ') || bl.startsWith('-') || bl === '\\\\') consumed++;
        }
        fileLines.splice(match, consumed, ...replacement);
        cursor = match + replacement.length;
      }
    }
    const outPath = sec.moveTo ?? sec.oldPath;
    if (sec.moveTo) {
      tree.now.set(sec.oldPath, null);
    }
    tree.now.set(outPath, joinFile(fileLines, crlf, eol));
  };
}

function reindentAdd(addLine: string, contextLine: string | undefined): string {
  if (contextLine === undefined) return addLine;
  // Only reindent if the add line has no leading whitespace
  if (addLine.trimStart() !== addLine) return addLine;
  const m = contextLine.match(/^(\s*)/);
  const indent = m ? m[1] : '';
  return indent + addLine.trimStart();
}

// --- Section 9: JSON (from starter, kept) ---

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
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
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Detect format ---

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

// --- Read patch based on format ---

function readPatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  switch (kind) {
    case 'json': return jsonEdits(text, lines);
    case 'unified': return readUnified(text, lines, strict);
    case 'search-replace': return readSearchReplace(text, lines, strict);
    case 'v4a': return readV4A(text, lines, strict);
    default: return [];
  }
}

// --- Main run ---

const explicitMoves: [string, string][] = [];

function run(args: string[]): { code: number; out: string[] } {
  explicitMoves.length = 0;
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
  let edits: Edit[];
  try {
    edits = readPatch(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const changedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const renames = new Map<string, string>();
  const deleted = new Set<string>();
  const added = new Map<string, string>();
  for (const p of changedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== null && now === null) {
      deleted.add(p);
    } else if (was === null && now !== null) {
      added.set(p, now);
    }
  }
  // Explicit moves from patch directives (rename with modifications)
  for (const [oldPath, newPath] of explicitMoves) {
    if (deleted.has(oldPath) && added.has(newPath)) {
      renames.set(oldPath, newPath);
      added.delete(newPath);
      deleted.delete(oldPath);
    }
  }
  // Content-based matching for remaining implicit renames
  for (const oldPath of [...deleted]) {
    const oldContent = tree.original(oldPath)!;
    for (const [newPath, newContent] of added) {
      if (oldContent === newContent) {
        renames.set(oldPath, newPath);
        added.delete(newPath);
        deleted.delete(oldPath);
        break;
      }
    }
  }
  const rEntries: string[] = [];
  for (const [oldPath, newPath] of renames) {
    rEntries.push(`R ${oldPath} -> ${newPath}`);
  }
  rEntries.sort((a, b) => {
    const aNew = a.split(' -> ')[1];
    const bNew = b.split(' -> ')[1];
    return Buffer.compare(Buffer.from(aNew), Buffer.from(bNew));
  });
  rows.push(...rEntries);
  for (const p of changedPaths) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (renames.has(p)) continue;
    let isRenameNew = false;
    for (const [, np] of renames) if (np === p) isRenameNew = true;
    if (isRenameNew) continue;
    if (was === null && now !== null) rows.push(`A ${p}`);
    else if (was !== null && now === null) rows.push(`D ${p}`);
    else if (was !== null && now !== null) rows.push(`M ${p}`);
  }
  const out = [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`];
  if (!check) {
    for (const p of changedPaths) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}