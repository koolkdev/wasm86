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
import { registerAliasesByWidth } from "#x86/registers.js";
import {
  widthMask,
  type OperandWidth,
  type Reg32,
  type RegisterAlias
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
  isRecipeSelected(recipe: ExprRecipe): boolean;
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
      return emitProjectExpr(body, recipe, children, context);
    case "bits":
      return emitBitsExpr(body, recipe, children, context);
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
  const fusedType = emitDirectSignedRegisterAliasInput(width, children, context) ??
    emitFusedSignedMemoryLoad(width, children, context);

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

type RegisterInputView = Readonly<{
  bitOffset: number;
  width: OperandWidth;
}>;

type RecipeRegisterInputView = RegisterInputView & Readonly<{
  child: ExprRecipe;
}>;

function emitProjectExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType {
  assert(recipe.expr.kind === "project", `expected project expression recipe, got ${recipe.expr.kind}`);
  const expr = recipe.expr;
  const directType = tryEmitDirectRegisterAliasView(
    context,
    children,
    { bitOffset: 0, width: expr.width }
  );

  if (directType !== undefined) {
    return directType;
  }

  children.emit("value");
  emitMaskI32ToWidth(body, expr.width);
  return wasmValueType.i32;
}

function emitBitsExpr(
  body: WasmFunctionBodyEncoder,
  recipe: Extract<ExprRecipe, { kind: "expr" }>,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType {
  assert(recipe.expr.kind === "bits", `expected bits expression recipe, got ${recipe.expr.kind}`);
  const expr = recipe.expr;
  const directType = tryEmitDirectRegisterAliasView(
    context,
    children,
    { bitOffset: expr.offset, width: expr.width }
  );

  if (directType !== undefined) {
    return directType;
  }

  children.emit("value");
  emitShiftRight(body, expr.offset);
  emitMaskI32ToWidth(body, expr.width);
  return wasmValueType.i32;
}

function tryEmitDirectRegisterAliasView(
  context: WasmCompositeExprContext,
  children: WasmExprChildEmitter,
  view: RegisterInputView,
  options: Readonly<{ signed?: boolean }> = {}
): WasmValueType | undefined {
  return tryEmitDirectRegisterAliasInput(
    context,
    view,
    children.recipe("value"),
    children.isSelected("value"),
    options
  );
}

function tryEmitDirectRegisterAliasInput(
  context: WasmCompositeExprContext,
  view: RegisterInputView,
  child: ExprRecipe,
  childSelected: boolean,
  options: Readonly<{ signed?: boolean }> = {}
): WasmValueType | undefined {
  if (childSelected) {
    return undefined;
  }

  const reg = directRegisterInput(child);

  if (reg === undefined) {
    return undefined;
  }

  const alias = canonicalRegisterAlias(reg, view);

  if (alias === undefined) {
    return undefined;
  }

  return context.sources.tryEmitRegisterAliasInput(alias, options);
}

function emitDirectSignedRegisterAliasInput(
  width: 8 | 16,
  children: WasmExprChildEmitter,
  context: WasmCompositeExprContext
): WasmValueType | undefined {
  const child = children.recipe("value");

  if (children.isSelected("value") || child.kind !== "expr") {
    return undefined;
  }

  const view = registerInputViewForRecipe(child);

  if (view === undefined || view.width !== width) {
    return undefined;
  }

  return tryEmitDirectRegisterAliasInput(
    context,
    view,
    view.child,
    context.isRecipeSelected(view.child),
    { signed: true }
  );
}

function registerInputViewForRecipe(recipe: Extract<ExprRecipe, { kind: "expr" }>): RecipeRegisterInputView | undefined {
  switch (recipe.expr.kind) {
    case "project":
      return {
        bitOffset: 0,
        width: recipe.expr.width,
        child: bindRecipeChildSlots(recipe).recipe("value")
      };
    case "bits":
      return {
        bitOffset: recipe.expr.offset,
        width: recipe.expr.width,
        child: bindRecipeChildSlots(recipe).recipe("value")
      };
    default:
      return undefined;
  }
}

function directRegisterInput(recipe: ExprRecipe): Reg32 | undefined {
  if (recipe.kind !== "expr" || recipe.expr.kind !== "input" || recipe.expr.source.kind !== "reg") {
    return undefined;
  }

  return recipe.expr.source.reg;
}

function canonicalRegisterAlias(base: Reg32, view: RegisterInputView): RegisterAlias | undefined {
  return registerAliasesByWidth[view.width].find((alias) =>
    alias.base === base &&
    alias.bitOffset === view.bitOffset
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
