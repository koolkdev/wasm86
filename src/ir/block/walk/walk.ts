import {
  BindingResolver
} from "#ir/block/bindings/resolver.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBlock,
  IrOp,
  ValueRef
} from "#ir/model/types.js";
import {
  BlockState,
  blockProgress,
  type BlockProgress
} from "./state.js";
import { opSite, type OpSite } from "./site.js";
import type { BlockWalkResult } from "./types.js";
import { ControlWalkOps } from "./control-ops.js";
import {
  DynamicRegisterWalkOps
} from "./dynamic-register-ops.js";
import type { RegisterAccessMode } from "#ir/block/state/register-materialization.js";
import { FlagWalkOps } from "./flag-ops.js";
import { MemoryWalkOps } from "./memory-ops.js";
import { BlockWalkRecorder } from "./recorder.js";
import { RegisterAccessValidator } from "./register-access-validator.js";
import { RegisterWalkState } from "./registers.js";
import { StorageWalkOps } from "./storage-ops.js";
import {
  ValueWalkOps
} from "./value-ops.js";
import type {
  BlockExternalValueResolver,
  BlockValueBindings
} from "./values.js";

export type BlockWalkInput = Readonly<{
  block: IrBlock;
  entry?: BlockState;
  resolver?: BindingResolver;
  values?: BlockValueBindings;
  value?: BlockExternalValueResolver;
  continuation?: ExprRef;
  dynamicRegisterAccessMode?: RegisterAccessMode;
}>;

export function walkExpressionBlock(input: BlockWalkInput): BlockWalkResult {
  return new ExpressionBlockWalker(input).walk();
}

class ExpressionBlockWalker {
  readonly #block: IrBlock;
  readonly #entry: BlockState;
  readonly #values: ValueWalkOps;
  readonly #recorder: BlockWalkRecorder;
  readonly #registers: RegisterWalkState;
  readonly #dynamic: DynamicRegisterWalkOps;
  readonly #memory: MemoryWalkOps;
  readonly #storage: StorageWalkOps;
  readonly #flags: FlagWalkOps;
  readonly #control: ControlWalkOps;
  #progress: BlockProgress;
  #opIndex = -1;

  constructor(input: BlockWalkInput) {
    const entry = input.entry ?? BlockState.initial();
    const resolver = input.resolver ?? new BindingResolver();
    const continuation = input.continuation === undefined
      ? undefined
      : canonicalizeExpr(input.continuation);

    this.#block = input.block;
    this.#entry = entry;
    this.#values = new ValueWalkOps({
      values: input.values,
      value: input.value,
      opIndex: () => this.#opIndex
    });
    this.#recorder = new BlockWalkRecorder();
    const registerValidator = new RegisterAccessValidator();
    this.#registers = new RegisterWalkState({
      registers: entry.registers,
      site: () => this.#site(),
      validator: registerValidator
    });
    this.#dynamic = new DynamicRegisterWalkOps({
      recorder: this.#recorder,
      registers: this.#registers,
      validator: registerValidator,
      site: () => this.#site(),
      snapshot: () => this.#snapshot(),
      mode: input.dynamicRegisterAccessMode ?? "exact-alias"
    });
    this.#memory = new MemoryWalkOps({
      recorder: this.#recorder,
      site: () => this.#site(),
      snapshot: () => this.#snapshot()
    });
    this.#storage = new StorageWalkOps({
      resolver,
      registers: this.#registers,
      dynamic: this.#dynamic,
      memory: this.#memory,
      value: (value) => this.#value(value)
    });
    this.#flags = new FlagWalkOps({
      flags: entry.flags,
      value: (value) => this.#value(value),
      opIndex: () => this.#opIndex
    });
    this.#control = new ControlWalkOps({
      recorder: this.#recorder,
      site: () => this.#site(),
      snapshot: () => this.#snapshot(),
      continuation,
      value: (value) => this.#value(value)
    });
    this.#progress = entry.progress;
  }

  walk(): BlockWalkResult {
    for (const [opIndex, op] of this.#block.entries()) {
      this.#opIndex = opIndex;
      this.#progress = blockProgress(opIndex, "before");
      this.#walkOp(op);
      this.#progress = blockProgress(opIndex, "after");
    }

    const final = this.#snapshot();
    return this.#recorder.result(this.#entry, final);
  }

  #walkOp(op: IrOp): void {
    switch (op.op) {
      case "get":
        this.#values.bind(op.dst, this.#storage.read(op.source, op.accessWidth ?? 32));
        return;
      case "set":
        this.#storage.write(op.target, this.#value(op.value), op.accessWidth ?? 32);
        return;
      case "memory.guard":
        this.#memory.guard(this.#value(op.address), op.byteLength, op.access);
        return;
      case "address":
        this.#values.bind(op.dst, this.#storage.address(op.operand));
        return;
      case "value.const":
        this.#values.bind(op.dst, this.#values.constant(op.type, op.value));
        return;
      case "value.binary":
        this.#values.bind(op.dst, this.#values.binary(op.operator, op.a, op.b));
        return;
      case "value.unary":
        this.#values.bind(op.dst, this.#values.unary(op.operator, op.value));
        return;
      case "value.select":
        this.#values.bind(op.dst, this.#values.select(op.condition, op.whenTrue, op.whenFalse));
        return;
      case "value.project":
        this.#values.bind(op.dst, this.#values.project(op.width, op.value));
        return;
      case "value.compare":
        this.#values.bind(op.dst, this.#values.compare(op.width, op.operator, op.a, op.b));
        return;
      case "flags.write":
        this.#flags.write(op);
        return;
      case "flags.condition":
        this.#values.bind(op.dst, this.#flags.condition(op.cc));
        return;
      case "next":
        this.#control.fallthrough();
        return;
      case "jump":
        this.#control.jump(this.#value(op.target));
        return;
      case "conditionalJump":
        this.#control.branch(
          this.#value(op.condition),
          this.#value(op.taken),
          op.notTaken
        );
        return;
      case "hostTrap":
        this.#control.hostTrap(this.#value(op.vector));
        return;
      default:
        throw new Error(`unsupported block walk op ${(op as { op: string }).op} at ${this.#opIndex}`);
    }
  }

  #value(value: ValueRef): ExprRef {
    return this.#values.resolve(value);
  }

  #site(): OpSite {
    return opSite(this.#opIndex);
  }

  #snapshot(): BlockState {
    return BlockState.create({
      registers: this.#registers.state,
      flags: this.#flags.state,
      progress: this.#progress
    });
  }
}
