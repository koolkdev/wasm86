declare const valueIdBrand: unique symbol;

type ValueIdIn<Kind extends "ir" | "backend"> = number & {
  readonly [valueIdBrand]: Kind;
};

export type ValueId = ValueIdIn<"ir">;
export type BackendValueId = ValueIdIn<"backend">;
export type AnyValueId = ValueId | BackendValueId;
export type ValueType = "i32" | "i64";

export type ValueInputFor<Id extends AnyValueId, Type extends ValueType = ValueType> = Readonly<{
  value: Id;
  type: Type;
}>;

export type ValueInput<Type extends ValueType = ValueType> = ValueInputFor<ValueId, Type>;
export type BackendValueInput<Type extends ValueType = ValueType> = ValueInputFor<
  BackendValueId,
  Type
>;

export function valueId(id: number): ValueId {
  return id as ValueId;
}

export function backendValueId(id: number): BackendValueId {
  return id as BackendValueId;
}
