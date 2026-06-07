import { assert } from "#common/assert.js";
import type { ExprRecipe } from "#ir/block/planning/values/index.js";
import type { ExprChildRole } from "#ir/expr/children.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  wasmValueType,
  type WasmValueType
} from "#wasm/encoder/types.js";
import { i32 } from "#x86/numeric.js";
import {
  widthMask,
  type OperandWidth
} from "#x86/types.js";
import { emitI32BinaryOp } from "../ops/bit-ops.js";
import {
  compareUsesSignedOrder,
  emitI32CompareOp
} from "../ops/conditions.js";
import {
  emitMaskI32ToWidth,
  emitSignExtendI32ToWidth
} from "../ops/width.js";
import type { WasmSourceReader } from "../sources/storage.js";
import { bindRecipeChildSlots } from "./children.js";
import type { WasmDefinitionRecipeEmitter } from "./recipes.js";

export type WasmExprChildEmitter = Readonly<{
  emit(role: ExprChildRole): WasmValueType;
  recipe(role: ExprChildRole): ExprRecipe;
  isSelected(role: ExprChildRole): boolean;
}>;

export type WasmExprRecipeEmitter = Readonly<{
  emitRecipe(recipe: ExprRecipe): WasmValueType;
  isRecipeSelected(recipe: ExprRecipe): boolean;
}>;

export type WasmCompositeExprContext = Readonly<{
  definitions: WasmDefinitionRecipeEmitter;
  emitRecipe(recipe: ExprRecipe): WasmValueType;
  sources: WasmSourceReader;
}>;

export function bindRecipeChildren(
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  emitter: WasmExprRecipeEmitter
): WasmExprChildEmitter {
  const children = bindRecipeChildSlots(recipe);

  return {
    emit: (role) => emitter.emitRecipe(children.recipe(role)),
    recipe: (role) => children.recipe(role),
    isSelected: (role) => emitter.isRecipeSelected(children.recipe(role))
  };
}

export function emitCompositeExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType {
  switch (recipe.expr.kind) {
    case "const":
      body.i32Const(i32(recipe.expr.value));
      return wasmValueType.i32;
    case "input":
      return emitInputExpr(context.sources, recipe.expr.source);
    case "binary":
      children.emit("left");
      children.emit("right");
      emitI32BinaryOp(body, recipe.expr.op);
      return wasmValueType.i32;
    case "unary":
      return emitUnaryExpr(body, recipe, children, context);
    case "select":
      children.emit("whenTrue");
      children.emit("whenFalse");
      children.emit("condition");
      body.select();
      return wasmValueType.i32;
    case "project":
      children.emit("value");
      emitMaskI32ToWidth(body, recipe.expr.width);
      return wasmValueType.i32;
    case "bits":
      children.emit("value");
      emitShiftRight(body, recipe.expr.offset);
      emitMaskI32ToWidth(body, recipe.expr.width);
      return wasmValueType.i32;
    case "insertBits":
      return emitInsertBitsExpr(body, recipe, children);
    case "compare":
      return emitCompareExpr(body, recipe, children);
  }
}

function emitInputExpr(
  sources: WasmSourceReader,
  source: Extract<ExprRef, { kind: "input" }>["source"]
): WasmValueType {
  switch (source.kind) {
    case "def":
      assert(
        false,
        `raw input(def ${source.id}) expression cannot be emitted directly; ` +
        "use a definition recipe or snapshot recipe"
      );
  }

  return sources.emitInput(source);
}

function emitUnaryExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType {
  assert(recipe.expr.kind === "unary", `expected unary expression recipe, got ${recipe.expr.kind}`);

  switch (recipe.expr.op) {
    case "extend8_s":
      return emitSignExtendExpr(body, 8, children, context);
    case "extend16_s":
      return emitSignExtendExpr(body, 16, children, context);
    case "popcnt":
      children.emit("value");
      body.i32Popcnt();
      return wasmValueType.i32;
  }
}

function emitSignExtendExpr(
  body: WasmFunctionBodyEncoder,
  width: 8 | 16,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType {
  const fusedType = emitFusedSignedMemoryLoad(width, children, context);

  if (fusedType !== undefined) {
    return fusedType;
  }

  children.emit("value");
  emitSignExtendI32ToWidth(body, width);
  return wasmValueType.i32;
}

function emitFusedSignedMemoryLoad(
  width: 8 | 16,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType | undefined {
  const child = children.recipe("value");

  if (child.kind !== "definition") {
    return undefined;
  }

  if (children.isSelected("value")) {
    return undefined;
  }

  const info = context.definitions.definitionInfo(child.definition);

  if (info?.kind !== "memoryLoad" || info.width !== width) {
    return undefined;
  }

  return context.definitions.emitDefinition(
    child.definition,
    () => context.emitRecipe(child.input),
    { signed: true }
  );
}

function emitInsertBitsExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter
): WasmValueType {
  assert(recipe.expr.kind === "insertBits", `expected insertBits expression recipe, got ${recipe.expr.kind}`);

  if (recipe.expr.width === 32) {
    children.emit("value");
    return wasmValueType.i32;
  }

  const mask = shiftedMask(recipe.expr.offset, recipe.expr.width);

  children.emit("base");
  body.i32Const(i32(~mask)).i32And();
  children.emit("value");
  emitMaskI32ToWidth(body, recipe.expr.width);
  emitShiftLeft(body, recipe.expr.offset);
  body.i32Or();
  return wasmValueType.i32;
}

function emitCompareExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter
): WasmValueType {
  assert(recipe.expr.kind === "compare", `expected compare expression recipe, got ${recipe.expr.kind}`);

  if (compareUsesSignedOrder(recipe.expr.op)) {
    emitSignedCompareChild(body, children, "left", recipe.expr.width);
    emitSignedCompareChild(body, children, "right", recipe.expr.width);
  } else {
    children.emit("left");
    emitMaskI32ToWidth(body, recipe.expr.width);
    children.emit("right");
    emitMaskI32ToWidth(body, recipe.expr.width);
  }

  emitI32CompareOp(body, recipe.expr.op);
  return wasmValueType.i32;
}

function emitSignedCompareChild(
  body: WasmFunctionBodyEncoder,
  children: WasmExprChildEmitter,
  role: "left" | "right",
  width: OperandWidth
): void {
  children.emit(role);
  emitSignExtendI32ToWidth(body, width);
}

function emitShiftRight(body: WasmFunctionBodyEncoder, offset: number): void {
  if (offset === 0) {
    return;
  }

  body.i32Const(offset).i32ShrU();
}

function emitShiftLeft(body: WasmFunctionBodyEncoder, offset: number): void {
  if (offset === 0) {
    return;
  }

  body.i32Const(offset).i32Shl();
}

function shiftedMask(offset: number, width: OperandWidth): number {
  if (width === 32) {
    return 0xffff_ffff;
  }

  return ((widthMask(width) << offset) >>> 0);
}
