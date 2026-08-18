import { assert } from "#common/assert.js";
import { validateStorageEffectRanges } from "#compiler/function/validate/resource.js";
import { FunctionDefinition } from "./functions.js";
import { FunctionImport } from "./imports.js";
import type { FunctionDeclaration, ProgramDeclarations } from "./program.js";
import type { ProgramResources } from "./resources.js";

export function validateProgramDeclarationEffects(declarations: ProgramDeclarations): void {
  for (const declaration of declarations.functions) {
    validateDeclaredFunctionEffects(declarations.resources, declaration);
  }
}

export function validateProgramExportTargets(declarations: ProgramDeclarations): void {
  const definitions = new Set(
    declarations.functions
      .filter((declaration) => declaration instanceof FunctionDefinition)
      .map((definition) => definition.ref)
  );

  for (const exported of declarations.exports) {
    assert(
      definitions.has(exported.target),
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
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
    if (access.kind !== "resource") {
      continue;
    }
    assert(
      resources.memoryImports.some((memory) => memory.ref === access.resource),
      `unknown program resource ${access.resource.id} declared by function ${declaration.ref.id}`
    );
  }
}
