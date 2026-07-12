declare const refBrand: unique symbol;

type Ref<TKind extends string> = Readonly<{
  [refBrand]: TKind;
  kind: TKind;
  id: string;
}>;

export type SignatureRef = Ref<"signature">;
export type FunctionRef = Ref<"function">;
export type ResourceRef = Ref<"resource">;
export type TableRef = Ref<"table">;
export type GlobalRef = Ref<"global">;
export type ExportRef = Ref<"export">;

export function signatureRef(id: string): SignatureRef {
  return createIdentity("signature", id);
}

export function functionRef(id: string): FunctionRef {
  return createIdentity("function", id);
}

export function resourceRef(id: string): ResourceRef {
  return createIdentity("resource", id);
}

export function tableRef(id: string): TableRef {
  return createIdentity("table", id);
}

export function exportRef(id: string): ExportRef {
  return createIdentity("export", id);
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
