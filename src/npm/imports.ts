import path from 'node:path';
import ts from 'typescript';
import type { Location, Unanalyzed } from '../types.js';
import { isInside, isTargetSpecifier, type BuiltProgram } from './program.js';

/** One imported name, before we know whether it changed. */
export interface ImportRef {
  name: string;
  specifier: string;
  locations: Location[];
}

export interface ImportScan {
  /** Repo-relative POSIX paths of files that import the package. */
  files: string[];
  refs: ImportRef[];
  unanalyzed: Unanalyzed[];
  /** Per absolute file: local identifier -> { name, specifier }, for break attribution. */
  localNames: Map<string, Map<string, { name: string; specifier: string }>>;
}

export function toLocation(repoRoot: string, sf: ts.SourceFile, node: ts.Node): Location {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: relPosix(repoRoot, sf.fileName), line: line + 1, column: character + 1 };
}

export function relPosix(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function specifierOf(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isRequireCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  );
}

/**
 * Finds every import of the target package in repo source files and records
 * the exported names that are actually used. Namespace imports are followed
 * to their member accesses; anything we cannot reduce to a name is reported
 * as unanalyzed rather than guessed.
 */
export function scanImports(repoRoot: string, built: BuiltProgram, pkg: string, overlay: string): ImportScan {
  const { program, checker } = built;
  const refs = new Map<string, ImportRef>();
  const unanalyzed = new Map<string, Unanalyzed>();
  const files = new Set<string>();
  const localNames: ImportScan['localNames'] = new Map();

  const addRef = (specifier: string, name: string, loc: Location) => {
    const key = `${specifier}\u0000${name}`;
    const existing = refs.get(key);
    if (existing) existing.locations.push(loc);
    else refs.set(key, { name, specifier, locations: [loc] });
  };
  const addUnanalyzed = (reason: string, loc: Location) => {
    const existing = unanalyzed.get(reason);
    if (existing) existing.locations.push(loc);
    else unanalyzed.set(reason, { reason, locations: [loc] });
  };
  const bindLocal = (sf: ts.SourceFile, local: string, name: string, specifier: string) => {
    let m = localNames.get(sf.fileName);
    if (!m) localNames.set(sf.fileName, (m = new Map()));
    m.set(local, { name, specifier });
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!isInside(repoRoot, sf.fileName) || isInside(overlay, sf.fileName)) continue;
    if (sf.fileName.includes(`${path.sep}node_modules${path.sep}`)) continue;

    /** Namespace-style bindings in this file: local symbol -> specifier. */
    const namespaces = new Map<ts.Symbol, string>();
    let touched = false;

    const visitTop = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        const spec = specifierOf(node.moduleSpecifier);
        if (!spec || !isTargetSpecifier(spec, pkg)) return;
        touched = true;
        const clause = node.importClause;
        if (!clause) {
          // Side-effect import; no symbols to track.
          return;
        }
        if (clause.name) {
          addRef(spec, 'default', toLocation(repoRoot, sf, clause.name));
          bindLocal(sf, clause.name.text, 'default', spec);
        }
        const nb = clause.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) {
            const exported = (el.propertyName ?? el.name).text;
            addRef(spec, exported, toLocation(repoRoot, sf, el));
            bindLocal(sf, el.name.text, exported, spec);
          }
        } else if (nb && ts.isNamespaceImport(nb)) {
          const sym = checker.getSymbolAtLocation(nb.name);
          if (sym) namespaces.set(sym, spec);
        }
        return;
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const spec = specifierOf(node.moduleReference.expression);
        if (!spec || !isTargetSpecifier(spec, pkg)) return;
        touched = true;
        const sym = checker.getSymbolAtLocation(node.name);
        if (sym) namespaces.set(sym, spec);
        return;
      }
      if (ts.isExportDeclaration(node)) {
        const spec = specifierOf(node.moduleSpecifier);
        if (!spec || !isTargetSpecifier(spec, pkg)) return;
        touched = true;
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            addRef(spec, (el.propertyName ?? el.name).text, toLocation(repoRoot, sf, el));
          }
        } else {
          addUnanalyzed(`re-exports everything from "${spec}"`, toLocation(repoRoot, sf, node));
        }
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          const init = decl.initializer;
          if (!init || !isRequireCall(init)) continue;
          const spec = (init.arguments[0] as ts.StringLiteralLike).text;
          if (!isTargetSpecifier(spec, pkg)) continue;
          touched = true;
          if (ts.isObjectBindingPattern(decl.name)) {
            for (const el of decl.name.elements) {
              if (el.dotDotDotToken) {
                addUnanalyzed(`rest-destructures "${spec}"`, toLocation(repoRoot, sf, el));
                continue;
              }
              const prop = el.propertyName ?? el.name;
              const exported = ts.isIdentifier(prop) ? prop.text : undefined;
              if (!exported) {
                addUnanalyzed(`computed destructure of "${spec}"`, toLocation(repoRoot, sf, el));
                continue;
              }
              addRef(spec, exported, toLocation(repoRoot, sf, el));
              if (ts.isIdentifier(el.name)) bindLocal(sf, el.name.text, exported, spec);
            }
          } else if (ts.isIdentifier(decl.name)) {
            const sym = checker.getSymbolAtLocation(decl.name);
            if (sym) namespaces.set(sym, spec);
          } else {
            addUnanalyzed(`unusual require() binding of "${spec}"`, toLocation(repoRoot, sf, decl));
          }
        }
      }
    };

    ts.forEachChild(sf, visitTop);

    // Second pass: dynamic imports, inline require().member, namespace member access.
    const visitAll = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const spec = specifierOf(node.arguments[0]);
        if (spec && isTargetSpecifier(spec, pkg)) {
          touched = true;
          // `const m = await import('pkg')` binds like a namespace import and
          // `const { a } = await import('pkg')` like a named one. Anything
          // else (a .then chain, a bare await) is listed, not guessed.
          const awaited = node.parent && ts.isAwaitExpression(node.parent) ? node.parent : undefined;
          const decl = awaited?.parent && ts.isVariableDeclaration(awaited.parent) ? awaited.parent : undefined;
          if (decl && ts.isIdentifier(decl.name)) {
            const sym = checker.getSymbolAtLocation(decl.name);
            if (sym) namespaces.set(sym, spec);
            else addUnanalyzed(`dynamic import("${spec}")`, toLocation(repoRoot, sf, node));
          } else if (decl && ts.isObjectBindingPattern(decl.name)) {
            for (const el of decl.name.elements) {
              const prop = el.propertyName ?? el.name;
              if (el.dotDotDotToken || !ts.isIdentifier(prop)) {
                addUnanalyzed(`dynamic import("${spec}") with a rest or computed binding`, toLocation(repoRoot, sf, el));
                continue;
              }
              addRef(spec, prop.text, toLocation(repoRoot, sf, el));
              if (ts.isIdentifier(el.name)) bindLocal(sf, el.name.text, prop.text, spec);
            }
          } else {
            addUnanalyzed(`dynamic import("${spec}")`, toLocation(repoRoot, sf, node));
          }
        }
      } else if (isRequireCall(node) && !(node.parent && ts.isVariableDeclaration(node.parent))) {
        const spec = (node.arguments[0] as ts.StringLiteralLike).text;
        if (isTargetSpecifier(spec, pkg)) {
          touched = true;
          const parent = node.parent;
          if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
            addRef(spec, parent.name.text, toLocation(repoRoot, sf, parent.name));
          } else {
            addUnanalyzed(`inline require("${spec}") used as a whole`, toLocation(repoRoot, sf, node));
          }
        }
      } else if (ts.isIdentifier(node) && namespaces.size > 0) {
        const sym = checker.getSymbolAtLocation(node);
        const spec = sym ? namespaces.get(sym) : undefined;
        if (spec) {
          const parent = node.parent;
          const isBinding =
            (parent && ts.isImportClause(parent)) ||
            (parent && ts.isNamespaceImport(parent)) ||
            (parent && ts.isImportEqualsDeclaration(parent)) ||
            (parent && ts.isVariableDeclaration(parent) && parent.name === node);
          if (!isBinding) {
            if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
              addRef(spec, parent.name.text, toLocation(repoRoot, sf, parent.name));
            } else if (parent && ts.isQualifiedName(parent) && parent.left === node) {
              addRef(spec, parent.right.text, toLocation(repoRoot, sf, parent.right));
            } else {
              addUnanalyzed(`uses the whole module "${spec}" as a value`, toLocation(repoRoot, sf, node));
            }
          }
        }
      }
      ts.forEachChild(node, visitAll);
    };
    visitAll(sf);

    if (touched) files.add(relPosix(repoRoot, sf.fileName));
  }

  const sortedRefs = [...refs.values()].sort((a, b) =>
    a.specifier === b.specifier ? a.name.localeCompare(b.name) : a.specifier.localeCompare(b.specifier),
  );
  return {
    files: [...files].sort(),
    refs: sortedRefs,
    unanalyzed: [...unanalyzed.values()],
    localNames,
  };
}
