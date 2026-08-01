import { assert } from "#common/assert.js";
import type { FunctionAnalysis } from "#compiler/wasm/legacy/analysis/model.js";
import { covers, type StorageAccess, type StorageEffects } from "#compiler/ir/effects.js";
import { describeNode } from "#compiler/ir/node.js";
import { validateStorageEffectRanges } from "#compiler/ir/validate/resource.js";
import { FunctionImport } from "./imports.js";
import type { FunctionDeclaration, ProgramDeclarations, ProgramFunction } from "./program.js";
import type { ProgramResources } from "./resources.js";

export function validateProgramDeclarations(declarations: ProgramDeclarations): void {
  for (const fn of declarations.functions) {
    validateDeclaredFunctionEffects(declarations.resources, fn);
  }
}

export function validateDeclaredFunctionEffects(
  resources: ProgramResources,
  declaration: FunctionDeclaration
): void {
  const label =
    declaration instanceof FunctionImport
      ? `function import ${declaration.ref.id} declared`
      : `function ${declaration.ref.id} declared`;

  validateStorageEffectRanges(declaration.effects, label);

  for (const access of [...declaration.effects.reads, ...declaration.effects.writes]) {
    if (access.space !== "resource") {
      continue;
    }
    assert(
      resources.memoryImports.some((memory) => memory.ref === access.resource),
      `unknown program resource ${access.resource.id} declared by function ${declaration.ref.id}`
    );
  }
}

export function validateFunctionEffectCoverage(
  fn: Pick<ProgramFunction, "ref" | "effects">,
  analysis: FunctionAnalysis
): void {
  const actual = inferEffects(analysis);

  assertEffectsCovered(fn, "read", actual.reads, fn.effects.reads);
  assertEffectsCovered(fn, "write", actual.writes, fn.effects.writes);
}

function inferEffects(analysis: FunctionAnalysis): StorageEffects {
  const reads = new Set<StorageAccess>();
  const writes = new Set<StorageAccess>();

  for (const site of analysis.sites()) {
    if (site.kind === "regionEnd") {
      continue;
    }
    const node = site.node;

    if (node.category === "operation" && !analysis.operationMustExecute(node)) {
      continue;
    }
    const { effects } = describeNode(node);

    addExternalEffects(effects.reads, reads);
    addExternalEffects(effects.writes, writes);
  }
  return { reads: [...reads], writes: [...writes] };
}

function addExternalEffects(effects: readonly StorageAccess[], target: Set<StorageAccess>): void {
  for (const effect of effects) {
    if (effect.space !== "variable") {
      target.add(effect);
    }
  }
}

function assertEffectsCovered(
  fn: Pick<ProgramFunction, "ref">,
  kind: "read" | "write",
  actual: readonly StorageAccess[],
  declared: readonly StorageAccess[]
): void {
  for (const access of actual) {
    assert(
      declared.some((candidate) => covers(candidate, access)),
      `function ${fn.ref.id} has an undeclared ${kind} effect`
    );
  }
}
