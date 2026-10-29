#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeNpm } from './npm/analyze.js';
import { detectChanges, type Detection } from './git.js';
import type { Report } from './types.js';
import { NpmProvider } from './registry/provider.js';
import { renderMarkdown, renderText } from './report/render.js';

const HELP = `bumpcheck — prove whether a dependency bump breaks the code that imports it

Usage
  bumpcheck <package> <from> <to> [options]
  bumpcheck --since <git-ref> [options]

  The second form finds every direct dependency whose version changed in any
  package.json between <git-ref> and HEAD, and checks each in its own
  directory. This is the form for CI on a dependency pull request.

Options
  --repo <dir>        Repository to analyze (default: current directory)
  --since <ref>       Detect bumps from git instead of naming one
  --format <fmt>      text | markdown | json (default: text)
  --json-out <file>   Also write the full JSON report to a file
  --cache-dir <dir>   Where package versions are cached
  --registry <url>    npm registry (default: npm config / BUMPCHECK_REGISTRY)
  --no-fail           Exit 0 even when breaks are found
  -h, --help          Show this help

Exit codes
  0  no breaks found
  1  at least one break found
  2  usage or analysis error

Example
  bumpcheck axios 1.6.8 1.7.2 --repo ./my-app --format markdown
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      since: { type: 'string' },
      format: { type: 'string', default: 'text' },
      'json-out': { type: 'string' },
      'cache-dir': { type: 'string' },
      registry: { type: 'string' },
      'no-fail': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || (values.since ? positionals.length !== 0 : positionals.length !== 3)) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  const format = values.format;
  if (format !== 'text' && format !== 'markdown' && format !== 'json') {
    process.stderr.write(`Unknown format "${format}". Use text, markdown, or json.\n`);
    return 2;
  }

  const providerOpts: { cacheDir?: string; registry?: string } = {};
  if (values['cache-dir']) providerOpts.cacheDir = values['cache-dir'];
  if (values.registry) providerOpts.registry = values.registry;

  const repoRoot = path.resolve(values.repo ?? process.cwd());
  const provider = new NpmProvider(providerOpts);

  const detection: Detection = values.since
    ? detectChanges(repoRoot, values.since)
    : { bumps: [{ dir: '', pkg: positionals[0]!, from: positionals[1]!, to: positionals[2]! }], transitive: [] };
  const targets = detection.bumps;

  if (targets.length === 0) {
    process.stdout.write(renderNoBumps(values.since!, detection, format) + '\n');
    if (values['json-out']) await writeFile(values['json-out'], JSON.stringify([], null, 2) + '\n');
    return 0;
  }

  const reports: Report[] = [];
  for (const t of targets) {
    reports.push(await analyzeNpm({ repoRoot: path.join(repoRoot, t.dir), pkg: t.pkg, from: t.from, to: t.to, provider }));
  }

  const render = (r: Report, i: number): string => {
    const dir = targets[i]!.dir;
    const prefix = dir && format !== 'json' ? (format === 'markdown' ? `_in \`${dir}/\`_\n\n` : `in ${dir}/\n`) : '';
    return prefix + (format === 'markdown' ? renderMarkdown(r) : renderText(r));
  };
  const body = format === 'json' ? JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) : reports.map(render).join('\n\n');
  process.stdout.write(body + '\n');
  if (values['json-out']) {
    await writeFile(values['json-out'], JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2) + '\n');
  }

  return reports.some((r) => r.breaks.length > 0) && !values['no-fail'] ? 1 : 0;
}

/**
 * A lockfile-only pull request has nothing bumpcheck can check, since it
 * only analyzes packages the repo imports directly. Say what moved anyway,
 * so the comment explains itself.
 */
function renderNoBumps(since: string, detection: Detection, format: string): string {
  const md = format === 'markdown';
  const lines: string[] = [];
  lines.push(md ? `### bumpcheck` : 'bumpcheck');
  lines.push('');
  lines.push(`No direct dependency changed since ${since}, so there is nothing to typecheck against.`);
  if (detection.transitive.length > 0) {
    const n = detection.transitive.length;
    lines.push('');
    lines.push(`${n} transitive package${n === 1 ? '' : 's'} moved in the lockfile:`);
    lines.push('');
    for (const t of detection.transitive.slice(0, 20)) {
      const where = t.dir ? ` (in ${t.dir}/)` : '';
      lines.push(md ? `- \`${t.pkg}\` ${t.from} → ${t.to}${where}` : `  ${t.pkg} ${t.from} -> ${t.to}${where}`);
    }
    if (n > 20) lines.push(md ? `- … ${n - 20} more` : `  … ${n - 20} more`);
    lines.push('');
    lines.push(
      md
        ? '<sub>bumpcheck checks packages this repo imports directly. Transitive changes are listed for the record and are not analyzed.</sub>'
        : 'bumpcheck checks packages this repo imports directly. Transitive changes are listed for the record and are not analyzed.',
    );
  }
  return lines.join('\n');
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`bumpcheck: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  },
);
