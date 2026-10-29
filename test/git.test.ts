import { mkdtemp, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectBumps, detectChanges, exactVersion } from '../src/git.js';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

async function repoWith(files: Record<string, unknown>, cwd: string, message: string): Promise<void> {
  for (const [file, value] of Object.entries(files)) {
    const full = path.join(cwd, file);
    await writeFile(full, JSON.stringify(value, null, 2));
    git(cwd, 'add', file);
  }
  git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
}

describe('exactVersion', () => {
  it('strips caret and tilde, rejects ranges', () => {
    expect(exactVersion('^1.2.3')).toBe('1.2.3');
    expect(exactVersion('~1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(exactVersion('>=1.0.0')).toBeUndefined();
    expect(exactVersion('latest')).toBeUndefined();
  });
});

describe('detectBumps', () => {
  it('finds bumped direct dependencies per directory, resolving ranges through the lockfile', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'bumpcheck-git-'));
    git(cwd, 'init', '-q');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(cwd, 'web'));
    await repoWith(
      {
        'package.json': { dependencies: { zod: '^3.23.0', left: '1.0.0' } },
        'package-lock.json': {
          packages: { 'node_modules/zod': { version: '3.23.8' }, 'node_modules/systeminformation': { version: '5.33.15' } },
        },
        'web/package.json': { dependencies: { react: '19.0.0' }, devDependencies: { vitest: '^2.0.0' } },
      },
      cwd,
      'base',
    );
    await repoWith(
      {
        'package.json': { dependencies: { zod: '^4.0.0', left: '1.0.0', added: '1.0.0' } },
        'package-lock.json': {
          packages: { 'node_modules/zod': { version: '4.1.12' }, 'node_modules/systeminformation': { version: '5.33.18' } },
        },
        'web/package.json': { dependencies: { react: '19.0.0' }, devDependencies: { vitest: '^3.0.0' } },
      },
      cwd,
      'bumps',
    );
    expect(detectBumps(cwd, 'HEAD~1')).toEqual([
      { dir: '', pkg: 'zod', from: '3.23.8', to: '4.1.12' },
      { dir: 'web', pkg: 'vitest', from: '2.0.0', to: '3.0.0' },
    ]);
    expect(detectChanges(cwd, 'HEAD~1').transitive).toEqual([
      { dir: '', pkg: 'systeminformation', from: '5.33.15', to: '5.33.18' },
    ]);
  });
});
