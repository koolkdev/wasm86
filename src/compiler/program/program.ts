import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { FunctionImport } from "./imports.js";
import type { FunctionExport } from "./exports.js";
import type { ProgramResources } from "./resources.js";

export type FunctionDeclaration = FunctionDefinition | FunctionImport;

export type ProgramDeclarations = Readonly<{
  owner: object;
  resources: ProgramResources;
  functions: readonly FunctionDeclaration[];
  exports: readonly FunctionExport[];
}>;

declare const programBrand: unique symbol;

// A finished program is a source declaration snapshot. Target reachability,
// planning, and numeric indices are decided only when it is compiled.
export type Program = ProgramDeclarations & Readonly<{ [programBrand]: true }>;
