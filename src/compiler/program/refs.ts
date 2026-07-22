declare const refBrand: unique symbol;

type Ref<TKind extends string> = Readonly<{
  [refBrand]: TKind;
  kind: TKind;
  id: string;
}>;

export type FunctionRef = Ref<"function">;
export type TableRef = Ref<"table">;
export type FunctionExportRef = Ref<"function-export">;

export function functionRef(id: string): FunctionRef {
  return createIdentity("function", id);
}

export function tableRef(id: string): TableRef {
  return createIdentity("table", id);
}

export function functionExportRef(id: string): FunctionExportRef {
  return createIdentity("function-export", id);
}

function createIdentity<TKind extends string>(kind: TKind, id: string): Ref<TKind> {
  if (id.length === 0) {
    throw new Error(`empty ${kind} identity`);
  }

  return {
    kind,
    id
  } as Ref<TKind>;
}
