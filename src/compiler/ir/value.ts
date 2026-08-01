declare const valueIdBrand: unique symbol;

export type ValueId = number & {
  readonly [valueIdBrand]: "ir";
};

export function valueId(id: number): ValueId {
  return id as ValueId;
}
