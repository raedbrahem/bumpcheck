import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRepoConfig } from '../src/npm/program.js';
import { fixtures } from './helpers.js';

describe('loadRepoConfig', () => {
  it('uses a tsconfig that lists files as is', () => {
    const config = loadRepoConfig(path.join(fixtures, 'consumer'));
    expect(config.source).toBe('tsconfig');
    expect(config.warnings).toEqual([]);
  });

  it('follows project references when tsconfig.json has no files of its own', () => {
    const root = path.join(fixtures, 'solution');
    const config = loadRepoConfig(root);
    expect(config.source).toBe('tsconfig');
    expect(config.fileNames.map((f) => path.relative(root, f))).toEqual(['src/app.ts', 'vite.config.ts']);
    expect(config.options.strict).toBe(false);
    expect(config.warnings).toEqual([
      'tsconfig.json: no files of its own; analyzed the 2 projects it references (tsconfig.app.json, tsconfig.node.json) as one program with the options of tsconfig.app.json (tsc -b checks each on its own; strictness may differ from your build)',
    ]);
  });
});
