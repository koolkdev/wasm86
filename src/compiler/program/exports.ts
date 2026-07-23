import type { FunctionRef } from "#compiler/ir/refs.js";

declare const refBrand: unique symbol;

export type FunctionExportRef = Readonly<{
  [refBrand]: "function-export";
  kind: "function-export";
  id: string;
}>;

export function functionExportRef(id: string): FunctionExportRef {
  if (id.length === 0) {
    throw new Error("empty function-export identity");
  }

  return {
    kind: "function-export",
    id
  } as FunctionExportRef;
}

export type FunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
  target: FunctionRef;
}>;
