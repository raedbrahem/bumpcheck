import type { Break, ImportedSymbol, Location, Report } from '../types.js';

const MAX_SIG = 160;

function loc(l: Location): string {
  return `${l.file}:${l.line}:${l.column}`;
}

function clip(s: string | undefined): string {
  if (!s) return '';
  const one = s.replace(/\n/g, ' ⏎ ');
  return one.length > MAX_SIG ? one.slice(0, MAX_SIG - 1) + '…' : one;
}

/**
 * Before/after excerpts centered on the first difference, so a change deep
 * inside a long declaration is visible instead of two identical prefixes.
 */
function diffClips(before: string | undefined, after: string | undefined): { before: string; after: string } {
  const a = (before ?? '').replace(/\n/g, ' ⏎ ');
  const b = (after ?? '').replace(/\n/g, ' ⏎ ');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const start = Math.max(0, i - Math.floor(MAX_SIG / 3));
  const cut = (s: string) => {
    const slice = s.slice(start, start + MAX_SIG);
    return (start > 0 ? '…' : '') + slice + (start + MAX_SIG < s.length ? '…' : '');
  };
  return { before: cut(a), after: cut(b) };
}

interface BreakGroup {
  symbol: string | undefined;
  message: string;
  kind: Break['kind'];
  code: number;
  sites: Location[];
}

/**
 * One line per distinct cause. 79 "Property 'errors' does not exist" lines
 * are one fact with 79 sites; the JSON report keeps every site.
 */
function groupBreaks(breaks: Break[]): BreakGroup[] {
  const groups = new Map<string, BreakGroup>();
  for (const b of breaks) {
    const message = generalize(b.message);
    const key = `${b.symbol ?? ''}\u0000${b.code}\u0000${message}`;
    const g = groups.get(key);
    if (g) g.sites.push(b.location);
    else groups.set(key, { symbol: b.symbol, message, kind: b.kind, code: b.code, sites: [b.location] });
  }
  return [...groups.values()].sort((x, y) => y.sites.length - x.sites.length);
}

/** Drops the per-site type arguments so identical causes share a line. */
function generalize(message: string): string {
  return message
    .replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>/g, '<…>')
    .replace(/'\{[^']*\}'/g, "'{…}'")
    .replace(/\s+/g, ' ')
    .trim();
}

function headline(r: Report): string {
  const n = r.summary.importedSymbols;
  const what = n === 1 ? '1 symbol' : `${n} symbols`;
  if (r.meta.untyped) {
    return `You import ${what} from ${r.package}. ${r.to} ships no type declarations, so nothing could be checked.`;
  }
  if (n === 0 && r.package.startsWith('@types/')) {
    return (
      `${r.package} is a type-only package: its declarations apply globally without an import, ` +
      `so there is nothing to trace to a call site. bumpcheck does not compare global declarations.`
    );
  }
  if (n === 0) {
    return `Nothing in this repo imports ${r.package}.`;
  }
  const s = r.summary;
  const parts: string[] = [];
  if (s.breaks > 0) {
    const affected = s.removed + s.breaking;
    const where = affected > 0 ? ` in ${affected} symbol${affected === 1 ? '' : 's'}` : '';
    parts.push(`${s.breaks} break${s.breaks === 1 ? '' : 's'}${where}`);
  }
  if (s.changed > 0) parts.push(`${s.changed} changed but still typecheck${s.changed === 1 ? 's' : ''}`);
  if (s.unknown > 0) parts.push(`${s.unknown} could not be checked`);
  const tail = parts.length === 0 ? 'None changed.' : parts.join(', ') + '.';
  return `You import ${what} from ${r.package}. ${tail} Behavior not checked.`;
}

function groupLines(g: BreakGroup, maxSites: number): string[] {
  const sym = g.symbol ? `${g.symbol}  ` : '';
  const count = g.sites.length === 1 ? '' : `  (${g.sites.length} sites)`;
  const lines = [`  ${sym}${g.message}  TS${g.code}${count}`];
  for (const l of g.sites.slice(0, maxSites)) lines.push(`    ${loc(l)}`);
  if (g.sites.length > maxSites) lines.push(`    … ${g.sites.length - maxSites} more, see --format json`);
  return lines;
}

function section(title: string, items: ImportedSymbol[], out: string[]): void {
  if (items.length === 0) return;
  out.push(title);
  for (const s of items) out.push(symbolLine(s));
  out.push('');
}

function symbolLine(s: ImportedSymbol): string {
  const d = diffClips(s.change?.before, s.change?.after);
  const sig =
    s.status === 'changed' || s.status === 'breaking'
      ? `\n    before: ${d.before}\n    after:  ${d.after}`
      : s.status === 'removed'
        ? `\n    was: ${clip(s.change?.before)}`
        : '';
  const locs = s.locations.map((l) => `    ${loc(l)}`).join('\n');
  return `  ${s.name}  [${s.specifier}]${sig}\n${locs}`;
}

/** Plain text for terminals. No color codes, so it pastes cleanly anywhere. */
export function renderText(r: Report): string {
  const out: string[] = [];
  out.push(`${r.package} ${r.from} -> ${r.to}`);
  out.push(headline(r));
  out.push('');

  if (r.breaks.length > 0) {
    out.push('BREAKS');
    for (const g of groupBreaks(r.breaks)) out.push(...groupLines(g, 5));
    out.push('');
  }
  section('REMOVED', r.imports.filter((i) => i.status === 'removed'), out);
  section('CHANGED, BREAKS ABOVE', r.imports.filter((i) => i.status === 'breaking'), out);
  section('CHANGED, STILL TYPECHECKS', r.imports.filter((i) => i.status === 'changed'), out);
  section('COULD NOT BE CHECKED', r.imports.filter((i) => i.status === 'unknown'), out);
  if (r.unanalyzed.length > 0) {
    out.push('NOT ANALYZED');
    for (const u of r.unanalyzed) {
      out.push(`  ${u.reason}`);
      for (const l of u.locations) out.push(`    ${loc(l)}`);
    }
    out.push('');
  }
  const unchanged = r.imports.filter((i) => i.status === 'unchanged');
  if (unchanged.length > 0) {
    out.push(`UNCHANGED (${unchanged.length})`);
    out.push('  ' + unchanged.map((s) => s.name).join(', '));
    out.push('');
  }
  out.push(`Checked ${r.files.length} file${r.files.length === 1 ? '' : 's'} with TypeScript ${r.meta.typescript} in ${r.meta.durationMs} ms.`);
  return out.join('\n');
}

/** GitHub-flavored markdown for a pull request comment. */
export function renderMarkdown(r: Report): string {
  const out: string[] = [];
  out.push(`### \`${r.package}\` ${r.from} → ${r.to}`);
  out.push('');
  out.push(headline(r));
  out.push('');

  if (r.breaks.length > 0) {
    out.push('**Breaks**');
    out.push('');
    for (const g of groupBreaks(r.breaks)) {
      const sym = g.symbol ? `\`${g.symbol}\` ` : '';
      if (g.sites.length === 1) {
        out.push(`- ${sym}${g.message}  `);
        out.push(`  \`${loc(g.sites[0]!)}\` (TS${g.code})`);
      } else {
        out.push(`- ${sym}${g.message} (TS${g.code})  `);
        out.push(`  <details><summary>${g.sites.length} sites</summary>`);
        out.push('');
        for (const l of g.sites) out.push(`  - \`${loc(l)}\``);
        out.push('');
        out.push('  </details>');
      }
    }
    out.push('');
  }
  const removed = r.imports.filter((i) => i.status === 'removed');
  if (removed.length > 0) {
    out.push('**Removed**');
    out.push('');
    for (const s of removed) {
      out.push(`- \`${s.name}\` from \`${s.specifier}\``);
      for (const l of s.locations) out.push(`  - \`${loc(l)}\``);
    }
    out.push('');
  }
  const breaking = r.imports.filter((i) => i.status === 'breaking');
  if (breaking.length > 0) {
    out.push('**Changed, see breaks above**');
    out.push('');
    for (const s of breaking) {
      const d = diffClips(s.change?.before, s.change?.after);
      out.push(`- \`${s.name}\` from \`${s.specifier}\``);
      out.push(`  - before: \`${d.before}\``);
      out.push(`  - after: \`${d.after}\``);
    }
    out.push('');
  }
  const changed = r.imports.filter((i) => i.status === 'changed');
  if (changed.length > 0) {
    out.push('<details><summary><b>Changed, still typechecks</b> (' + changed.length + ')</summary>');
    out.push('');
    for (const s of changed) {
      const d = diffClips(s.change?.before, s.change?.after);
      out.push(`- \`${s.name}\` from \`${s.specifier}\``);
      out.push(`  - before: \`${d.before}\``);
      out.push(`  - after: \`${d.after}\``);
      for (const l of s.locations) out.push(`  - \`${loc(l)}\``);
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  const unknown = r.imports.filter((i) => i.status === 'unknown');
  if (unknown.length > 0 || r.unanalyzed.length > 0) {
    out.push('<details><summary><b>Could not be checked</b></summary>');
    out.push('');
    for (const s of unknown) {
      out.push(`- \`${s.name}\` from \`${s.specifier}\``);
      for (const l of s.locations) out.push(`  - \`${loc(l)}\``);
    }
    for (const u of r.unanalyzed) {
      out.push(`- ${u.reason}`);
      for (const l of u.locations) out.push(`  - \`${loc(l)}\``);
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  out.push(
    `<sub>Checked ${r.files.length} file${r.files.length === 1 ? '' : 's'} with TypeScript ${r.meta.typescript}. ` +
      `Facts only: declarations of both versions against this repo's source. Runtime behavior is not checked.</sub>`,
  );
  return out.join('\n');
}
