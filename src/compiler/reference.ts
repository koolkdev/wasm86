import { assert } from "#common/assert.js";

declare const refBrand: unique symbol;

type Ref<Kind extends string> = Readonly<{
  [refBrand]: Kind;
  kind: Kind;
  id: string;
}>;

export type FunctionRef = Ref<"function">;
export type ResourceRef = Ref<"resource">;
export type TableRef = Ref<"table">;

export function functionRef(id: string): FunctionRef {
  return createReference("function", id);
}

export function resourceRef(id: string): ResourceRef {
  return createReference("resource", id);
}

export function tableRef(id: string): TableRef {
  return createReference("table", id);
}

function createReference<Kind extends string>(kind: Kind, id: string): Ref<Kind> {
  assert(id.length > 0, `empty ${kind} identity`);

  return {
    kind,
    id
  } as Ref<Kind>;
}
