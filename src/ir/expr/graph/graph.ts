import type { FlagName } from "#ir/model/flags.js";
import {
  type OperandWidth,
  type Reg32,
  widthMask
} from "#x86/types.js";
import { i32 } from "#x86/numeric.js";
import {
  bitRangeMask,
  exprBinary,
  exprBits,
  exprCompare,
  exprConst,
  exprInput,
  exprInsertBits,
  exprProject,
  exprSelect,
  exprUnary
} from "../builders.js";
import { exprChildren } from "../children.js";
import type {
  ExprInputSource,
  ExprRef,
  ScalarBinaryOp,
  ScalarCompareOp,
  ScalarUnaryOp
} from "../types.js";
import type {
  ExprGraph,
  ExprGraphAnalysis,
  ExprNode,
  ExprNodeId,
  ExprOrder
} from "./types.js";
import {
  get2,
  get3,
  get4,
  put2,
  put3,
  put4,
  type Map2,
  type Map3,
  type Map4
} from "./nested-map.js";

type Frame =
  | Readonly<{ kind: "enter"; expr: ExprRef }>
  | Readonly<{ kind: "resolve"; expr: ExprRef; childCount: number }>;

type ResolvedExpr =
  | Readonly<{ kind: "canonical"; expr: ExprRef; children: readonly ExprNode[] }>
  | Readonly<{ kind: "redirect"; expr: ExprRef }>;

export function buildExprGraph(roots: Iterable<ExprRef>): ExprGraph {
  return buildClosedExprGraph(roots);
}

export function buildExprGraphAnalysis(roots: Iterable<ExprRef>): ExprGraphAnalysis {
  const graph = buildClosedExprGraph(roots);

  return Object.freeze({
    order: graph.order,
    identity: graph
  });
}

function buildClosedExprGraph(roots: Iterable<ExprRef>): BuiltExprGraph {
  const interner = new ExprNodeInterner();

  for (const root of roots) {
    interner.resolve(root, true);
  }

  return new BuiltExprGraph(interner);
}

class BuiltExprGraph implements ExprGraph {
  readonly #interner: ExprNodeInterner;
  readonly #nodes: readonly ExprNode[];
  readonly order: ExprOrder;

  constructor(interner: ExprNodeInterner) {
    this.#interner = interner;
    this.#nodes = Object.freeze([...interner.nodes]);
    this.order = this.#nodes;
  }

  node(expr: ExprRef): ExprNode {
    return this.#interner.resolve(expr, false);
  }

  get(id: ExprNodeId): ExprNode {
    if (!Number.isInteger(id) || id < 0 || id >= this.#nodes.length) {
      throw new Error(`unknown expression graph node id ${id}`);
    }

    return this.#nodes[id]!;
  }
}

class ExprNodeInterner {
  readonly nodes: ExprNode[] = [];

  readonly #constNodes = new Map<number, ExprNode>();
  readonly #regInputNodes = new Map<Reg32, ExprNode>();
  readonly #flagInputNodes = new Map<FlagName, ExprNode>();
  readonly #defInputNodes = new Map<number, ExprNode>();
  readonly #binaryNodes: Map3<ScalarBinaryOp, ExprNodeId, ExprNodeId, ExprNode> = new Map();
  readonly #unaryNodes: Map2<ScalarUnaryOp, ExprNodeId, ExprNode> = new Map();
  readonly #selectNodes: Map3<ExprNodeId, ExprNodeId, ExprNodeId, ExprNode> = new Map();
  readonly #projectNodes: Map2<OperandWidth, ExprNodeId, ExprNode> = new Map();
  readonly #bitsNodes: Map3<number, OperandWidth, ExprNodeId, ExprNode> = new Map();
  readonly #insertBitsNodes: Map4<number, OperandWidth, ExprNodeId, ExprNodeId, ExprNode> = new Map();
  readonly #compareNodes: Map4<OperandWidth, ScalarCompareOp, ExprNodeId, ExprNodeId, ExprNode> = new Map();

  resolve(expr: ExprRef, allowCreate: boolean): ExprNode {
    const stack: Frame[] = [{ kind: "enter", expr }];
    const results: ExprNode[] = [];

    while (stack.length > 0) {
      const frame = stack.pop()!;

      switch (frame.kind) {
        case "enter": {
          const children = exprChildren(frame.expr);

          if (children.length === 0) {
            results.push(this.#lookupOrCreateResolved(resolveLeafExpr(frame.expr), allowCreate));
            break;
          }

          stack.push({ kind: "resolve", expr: frame.expr, childCount: children.length });

          for (let index = children.length - 1; index >= 0; index -= 1) {
            stack.push({ kind: "enter", expr: children[index]! });
          }

          break;
        }
        case "resolve": {
          const childNodes = popChildNodes(results, frame.childCount);
          const resolved = resolveParentExpr(frame.expr, childNodes);

          if (resolved.kind === "redirect") {
            stack.push({ kind: "enter", expr: resolved.expr });
            break;
          }

          results.push(this.#lookupOrCreateResolved(resolved, allowCreate));
          break;
        }
      }
    }

    if (results.length !== 1) {
      throw new Error("expression graph resolution produced an invalid result stack");
    }

    return results[0]!;
  }

  #lookupOrCreateResolved(resolved: Extract<ResolvedExpr, { kind: "canonical" }>, allowCreate: boolean): ExprNode {
    const existing = this.#lookup(resolved.expr, resolved.children);

    if (existing !== undefined) {
      return existing;
    }

    if (!allowCreate) {
      throw new Error(`expression graph is closed; missing ${resolved.expr.kind} node`);
    }

    const children = Object.freeze([...resolved.children]);
    const node = Object.freeze({
      id: this.nodes.length,
      expr: resolved.expr,
      children
    });

    this.nodes.push(node);
    this.#store(node);
    return node;
  }

  #lookup(expr: ExprRef, children: readonly ExprNode[]): ExprNode | undefined {
    switch (expr.kind) {
      case "const":
        assertChildCount(expr.kind, children, 0);
        return this.#constNodes.get(i32(expr.value));
      case "input":
        assertChildCount(expr.kind, children, 0);
        return this.#lookupInput(expr.source);
      case "binary":
        assertChildCount(expr.kind, children, 2);
        return get3(this.#binaryNodes, expr.op, children[0]!.id, children[1]!.id);
      case "unary":
        assertChildCount(expr.kind, children, 1);
        return get2(this.#unaryNodes, expr.op, children[0]!.id);
      case "select":
        assertChildCount(expr.kind, children, 3);
        return get3(this.#selectNodes, children[0]!.id, children[1]!.id, children[2]!.id);
      case "project":
        assertChildCount(expr.kind, children, 1);
        return get2(this.#projectNodes, expr.width, children[0]!.id);
      case "bits":
        assertChildCount(expr.kind, children, 1);
        return get3(this.#bitsNodes, expr.offset, expr.width, children[0]!.id);
      case "insertBits":
        assertChildCount(expr.kind, children, 2);
        return get4(this.#insertBitsNodes, expr.offset, expr.width, children[0]!.id, children[1]!.id);
      case "compare":
        assertChildCount(expr.kind, children, 2);
        return get4(this.#compareNodes, expr.width, expr.op, children[0]!.id, children[1]!.id);
    }
  }

  #store(node: ExprNode): void {
    const expr = node.expr;
    const children = node.children;

    switch (expr.kind) {
      case "const":
        this.#constNodes.set(i32(expr.value), node);
        return;
      case "input":
        this.#storeInput(expr.source, node);
        return;
      case "binary":
        put3(this.#binaryNodes, expr.op, children[0]!.id, children[1]!.id, node);
        return;
      case "unary":
        put2(this.#unaryNodes, expr.op, children[0]!.id, node);
        return;
      case "select":
        put3(this.#selectNodes, children[0]!.id, children[1]!.id, children[2]!.id, node);
        return;
      case "project":
        put2(this.#projectNodes, expr.width, children[0]!.id, node);
        return;
      case "bits":
        put3(this.#bitsNodes, expr.offset, expr.width, children[0]!.id, node);
        return;
      case "insertBits":
        put4(this.#insertBitsNodes, expr.offset, expr.width, children[0]!.id, children[1]!.id, node);
        return;
      case "compare":
        put4(this.#compareNodes, expr.width, expr.op, children[0]!.id, children[1]!.id, node);
        return;
    }
  }

  #lookupInput(source: ExprInputSource): ExprNode | undefined {
    switch (source.kind) {
      case "reg":
        return this.#regInputNodes.get(source.reg);
      case "flag":
        return this.#flagInputNodes.get(source.flag);
      case "def":
        return this.#defInputNodes.get(source.id);
    }
  }

  #storeInput(source: ExprInputSource, node: ExprNode): void {
    switch (source.kind) {
      case "reg":
        this.#regInputNodes.set(source.reg, node);
        return;
      case "flag":
        this.#flagInputNodes.set(source.flag, node);
        return;
      case "def":
        this.#defInputNodes.set(source.id, node);
        return;
    }
  }
}

function resolveLeafExpr(expr: ExprRef): Extract<ResolvedExpr, { kind: "canonical" }> {
  switch (expr.kind) {
    case "const":
      return canonical(exprConst(expr.value), []);
    case "input":
      return canonical(exprInput(expr.source), []);
    case "binary":
    case "unary":
    case "select":
    case "project":
    case "bits":
    case "insertBits":
    case "compare":
      throw new Error(`${expr.kind} expression is not a leaf`);
  }
}

function resolveParentExpr(expr: ExprRef, children: readonly ExprNode[]): ResolvedExpr {
  switch (expr.kind) {
    case "const":
    case "input":
      throw new Error(`${expr.kind} expression is not a parent`);
    case "binary": {
      const left = childNode(expr.kind, children, 0);
      const right = childNode(expr.kind, children, 1);

      return canonical(exprBinary(expr.op, left.expr, right.expr), [left, right]);
    }
    case "unary": {
      const value = childNode(expr.kind, children, 0);

      return canonical(exprUnary(expr.op, value.expr), [value]);
    }
    case "select": {
      const condition = childNode(expr.kind, children, 0);
      const whenTrue = childNode(expr.kind, children, 1);
      const whenFalse = childNode(expr.kind, children, 2);

      return canonical(exprSelect(condition.expr, whenTrue.expr, whenFalse.expr), [
        condition,
        whenTrue,
        whenFalse
      ]);
    }
    case "project":
      return resolveProjectExpr(expr.width, childNode(expr.kind, children, 0));
    case "bits":
      return resolveBitsExpr(expr.offset, expr.width, childNode(expr.kind, children, 0));
    case "insertBits":
      return resolveInsertBitsExpr(
        childNode(expr.kind, children, 0),
        childNode(expr.kind, children, 1),
        expr.offset,
        expr.width
      );
    case "compare": {
      const left = childNode(expr.kind, children, 0);
      const right = childNode(expr.kind, children, 1);

      return canonical(exprCompare(expr.width, expr.op, left.expr, right.expr), [left, right]);
    }
  }
}

function resolveProjectExpr(width: OperandWidth, valueNode: ExprNode): ResolvedExpr {
  const value = valueNode.expr;

  if (width === 32) {
    return redirect(value);
  }

  if (value.kind === "const") {
    return redirect(exprConst(projectConst(value.value, width)));
  }

  if (value.kind === "project") {
    return redirect(exprProject(narrowerWidth(width, value.width), childNode(value.kind, valueNode.children, 0).expr));
  }

  if (value.kind === "bits" && value.offset === 0) {
    return redirect(exprProject(narrowerWidth(width, value.width), childNode(value.kind, valueNode.children, 0).expr));
  }

  return canonical(exprProject(width, value), [valueNode]);
}

function resolveBitsExpr(offset: number, width: OperandWidth, valueNode: ExprNode): ResolvedExpr {
  const value = valueNode.expr;

  if (offset === 0 && width === 32) {
    return redirect(value);
  }

  if (offset === 0) {
    return redirect(exprProject(width, value));
  }

  if (value.kind === "const") {
    return redirect(exprConst(extractConstBits(value.value, offset, width)));
  }

  if (value.kind === "bits" && offset + width <= value.width) {
    return redirect(exprBits(childNode(value.kind, valueNode.children, 0).expr, value.offset + offset, width));
  }

  if (value.kind === "project" && offset >= value.width) {
    return redirect(exprConst(0));
  }

  return canonical(exprBits(value, offset, width), [valueNode]);
}

function resolveInsertBitsExpr(
  baseNode: ExprNode,
  valueNode: ExprNode,
  offset: number,
  width: OperandWidth
): ResolvedExpr {
  const base = baseNode.expr;
  const value = valueNode.expr;

  if (offset === 0 && width === 32) {
    return redirect(value);
  }

  if (base.kind === "const" && value.kind === "const") {
    return redirect(exprConst(insertConstBits(base.value, value.value, offset, width)));
  }

  if (
    value.kind === "bits" &&
    value.offset === offset &&
    value.width === width &&
    childNode(value.kind, valueNode.children, 0) === baseNode
  ) {
    return redirect(base);
  }

  if (
    offset === 0 &&
    value.kind === "project" &&
    value.width === width &&
    childNode(value.kind, valueNode.children, 0) === baseNode
  ) {
    return redirect(base);
  }

  if (base.kind === "insertBits" && base.offset === offset && base.width === width) {
    return redirect(exprInsertBits(childNode(base.kind, baseNode.children, 0).expr, value, offset, width));
  }

  return canonical(exprInsertBits(base, value, offset, width), [baseNode, valueNode]);
}

function canonical(expr: ExprRef, children: readonly ExprNode[]): Extract<ResolvedExpr, { kind: "canonical" }> {
  return { kind: "canonical", expr, children };
}

function redirect(expr: ExprRef): Extract<ResolvedExpr, { kind: "redirect" }> {
  return { kind: "redirect", expr };
}

function popChildNodes(results: ExprNode[], count: number): readonly ExprNode[] {
  if (results.length < count) {
    throw new Error("expression graph resolution lost child nodes");
  }

  const start = results.length - count;
  const children = results.slice(start);
  results.length = start;
  return children;
}

function childNode(kind: string, children: readonly ExprNode[], index: number): ExprNode {
  const child = children[index];

  if (child === undefined) {
    throw new Error(`${kind} expression is missing child ${index}`);
  }

  return child;
}

function assertChildCount(kind: string, children: readonly ExprNode[], count: number): void {
  if (children.length !== count) {
    throw new Error(`${kind} expression expected ${count} children, got ${children.length}`);
  }
}

function projectConst(value: number, width: OperandWidth): number {
  return i32((value >>> 0) & (widthMask(width) >>> 0));
}

function extractConstBits(value: number, bitOffset: number, width: OperandWidth): number {
  return i32(((value >>> 0) >>> bitOffset) & (widthMask(width) >>> 0));
}

function insertConstBits(base: number, value: number, bitOffset: number, width: OperandWidth): number {
  const mask = bitRangeMask(bitOffset, width);
  const replacement = (((value >>> 0) & (widthMask(width) >>> 0)) << bitOffset) >>> 0;

  return i32(((base >>> 0) & (~mask >>> 0)) | replacement);
}

function narrowerWidth(left: OperandWidth, right: OperandWidth): OperandWidth {
  return left < right ? left : right;
}
