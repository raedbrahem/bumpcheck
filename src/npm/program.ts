import path from 'node:path';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import semver from 'semver';
import ts from 'typescript';

export interface RepoConfig {
  options: ts.CompilerOptions;
  fileNames: string[];
  /** Where the options came from, for the report's meta. */
  source: 'tsconfig' | 'default';
  /** Config problems that change what can be proven, e.g. an unresolved `extends`. */
  warnings: string[];
}

export interface Target {
  pkg: string;
  /** Overlay root containing `node_modules/<pkg>`. */
  overlay: string;
}

export interface BuiltProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
  /** Resolve a specifier (`pkg` or `pkg/sub`) against the overlay. */
  resolveTarget(specifier: string): ts.ResolvedModuleWithFailedLookupLocations;
}

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo']);

export function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isTargetSpecifier(specifier: string, pkg: string): boolean {
  return specifier === pkg || specifier.startsWith(pkg + '/');
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; relative -> undefined. */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? (parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined) : parts[0];
}

interface Manifest {
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function readManifest(file: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}

/**
 * Options we always force. We never emit, we never check library files, and
 * we do not want incremental state leaking across the two runs.
 */
function sanitize(options: ts.CompilerOptions): ts.CompilerOptions {
  const out: ts.CompilerOptions = { ...options };
  out.noEmit = true;
  out.skipLibCheck = true;
  delete out.incremental;
  delete out.composite;
  delete out.tsBuildInfoFile;
  delete out.outDir;
  delete out.outFile;
  delete out.declaration;
  delete out.declarationDir;
  delete out.declarationMap;
  delete out.sourceMap;
  delete out.emitDeclarationOnly;
  return out;
}

export function walkSources(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (SOURCE_EXT.has(path.extname(entry)) && !entry.endsWith('.d.ts')) out.push(full);
    }
  }
  return out.sort();
}

function parseConfig(configPath: string): ts.ParsedCommandLine | undefined {
  const raw = ts.readConfigFile(configPath, ts.sys.readFile);
  if (raw.error) return undefined;
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath), undefined, configPath);
}

function configWarnings(configPath: string, parsed: ts.ParsedCommandLine): string[] {
  return parsed.errors
    .filter((e) => e.category === ts.DiagnosticCategory.Error)
    .map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' '))
    .filter((m) => /extends|not found|cannot read/i.test(m))
    .map((m) => `${path.basename(configPath)}: ${m} (analyzed without it; strictness may differ from your build)`);
}

interface Project {
  config: string;
  fileNames: string[];
  options: ts.CompilerOptions;
  warnings: string[];
}

/**
 * A config that lists files is one project. A solution-style config, with
 * `files: []` and `references` as Vite templates ship, owns no files, so the
 * projects it references stand in for it.
 */
function collectProjects(configPath: string, seen: Set<string>): Project[] {
  if (seen.has(configPath)) return [];
  seen.add(configPath);
  const parsed = parseConfig(configPath);
  if (!parsed) return [];
  if (parsed.fileNames.length > 0) {
    return [{ config: configPath, fileNames: parsed.fileNames, options: parsed.options, warnings: configWarnings(configPath, parsed) }];
  }
  return (parsed.projectReferences ?? []).flatMap((ref) => collectProjects(ts.resolveProjectReferencePath(ref), seen));
}

export function loadRepoConfig(repoRoot: string): RepoConfig {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (configPath && (isInside(repoRoot, configPath) || path.dirname(configPath) === repoRoot)) {
    const projects = collectProjects(configPath, new Set());
    const first = projects[0];
    if (first) {
      const warnings = projects.flatMap((p) => p.warnings);
      if (first.config !== configPath) {
        // tsc -b checks each referenced project with its own options. One
        // program cannot, so the first project's options apply to all.
        const names = projects.map((p) => path.relative(repoRoot, p.config)).join(', ');
        warnings.push(
          `${path.basename(configPath)}: no files of its own; analyzed the ${projects.length} project${projects.length === 1 ? '' : 's'} it references (${names}) as one program with the options of ${path.relative(repoRoot, first.config)} (tsc -b checks each on its own; strictness may differ from your build)`,
        );
      }
      const fileNames = [...new Set(projects.flatMap((p) => p.fileNames))];
      return { options: sanitize(first.options), fileNames, source: 'tsconfig', warnings };
    }
  }
  return {
    options: sanitize({
      allowJs: true,
      checkJs: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      esModuleInterop: true,
      resolveJsonModule: true,
    }),
    fileNames: walkSources(repoRoot),
    source: 'default',
    warnings: [],
  };
}

/**
 * Builds a program over the repo where every import of the target package is
 * resolved from the overlay instead of the repo's own node_modules. Files
 * inside the overlay resolve normally, so the package's own dependencies work.
 */
export function buildProgram(repoRoot: string, config: RepoConfig, target: Target): BuiltProgram {
  const host = ts.createCompilerHost(config.options, true);
  const anchor = path.join(target.overlay, '__bumpcheck_anchor__.ts');
  const repoCache = ts.createModuleResolutionCache(repoRoot, host.getCanonicalFileName, config.options);
  const overlayCache = ts.createModuleResolutionCache(target.overlay, host.getCanonicalFileName, config.options);

  const resolveTarget = (specifier: string): ts.ResolvedModuleWithFailedLookupLocations =>
    ts.resolveModuleName(specifier, anchor, config.options, host, overlayCache);

  // The package's own dependencies come from the repo when the repo's
  // installed version satisfies the declared range, which is what npm's
  // dedupe does. Otherwise two copies of a shared dependency (say
  // @nestjs/common) would produce "types have separate declarations" errors
  // that no real install has.
  const manifest = readManifest(path.join(target.overlay, 'node_modules', target.pkg, 'package.json'));
  const ranges: Record<string, string> = {
    ...manifest?.optionalDependencies,
    ...manifest?.dependencies,
    ...manifest?.peerDependencies,
  };
  const repoAnchor = path.join(repoRoot, '__bumpcheck_anchor__.ts');
  const repoVersions = new Map<string, string | undefined>();
  const repoSatisfies = (name: string): boolean => {
    const range = ranges[name];
    if (!range) return false;
    if (!repoVersions.has(name)) {
      repoVersions.set(name, readManifest(path.join(repoRoot, 'node_modules', name, 'package.json'))?.version);
    }
    const version = repoVersions.get(name);
    return !!version && semver.satisfies(version, range, { includePrerelease: true });
  };

  host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options) =>
    literals.map((lit) => {
      const fromOverlay = isInside(target.overlay, containingFile);
      if (isTargetSpecifier(lit.text, target.pkg) && !fromOverlay) {
        return resolveTarget(lit.text);
      }
      if (fromOverlay) {
        const dep = packageNameOf(lit.text);
        if (dep && dep !== target.pkg && repoSatisfies(dep)) {
          return ts.resolveModuleName(lit.text, repoAnchor, options, host, repoCache, redirectedReference);
        }
      }
      return ts.resolveModuleName(lit.text, containingFile, options, host, repoCache, redirectedReference);
    });

  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options, host });
  return { program, checker: program.getTypeChecker(), resolveTarget };
}
