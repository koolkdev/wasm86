import type { JitOperandBinding } from "./operand-bindings.js";
import type { IrVarAllocator } from "#x86/ir/build/builder.js";
import { const32 } from "#x86/ir/build/builder.js";
import type {
  IrBinaryOperator,
  IrOp,
  OperandRef,
  RegRef,
  StorageRef,
  ValueRef,
  VarRef
} from "#x86/ir/model/types.js";
import type { EffectiveAddress, OperandWidth, RegisterAlias, Reg32 } from "#x86/isa/types.js";
import { u32 } from "#x86/numeric.js";

export type BindInstructionIrInput = Readonly<{
  ir: readonly IrOp[];
  operands: readonly JitOperandBinding[];
  nextEip: number;
  allocator: IrVarAllocator;
}>;

export function bindInstructionIr(input: BindInstructionIrInput): readonly IrOp[] {
  return new InstructionIrBinder(input).build();
}

class InstructionIrBinder {
  readonly #input: BindInstructionIrInput;
  readonly #ops: IrOp[] = [];
  readonly #addressVarByOperandRef = new WeakMap<OperandRef, VarRef>();

  constructor(input: BindInstructionIrInput) {
    this.#input = input;
  }

  build(): readonly IrOp[] {
    for (const op of this.#input.ir) {
      this.#appendOp(op);
    }

    return this.#ops;
  }

  #appendOp(op: IrOp): void {
    switch (op.op) {
      case "get":
        this.#appendGet(op);
        return;
      case "set":
        this.#appendSet(op);
        return;
      case "memory.guard":
        this.#ops.push({
          ...op,
          address: this.#value(op.address)
        });
        return;
      case "address":
        this.#appendAddress(op);
        return;
      case "value.const":
        this.#ops.push(op);
        return;
      case "value.binary":
        this.#ops.push({ ...op, a: this.#value(op.a), b: this.#value(op.b) });
        return;
      case "value.unary":
        this.#ops.push({ ...op, value: this.#value(op.value) });
        return;
      case "value.select":
        this.#ops.push({
          ...op,
          condition: this.#value(op.condition),
          whenTrue: this.#value(op.whenTrue),
          whenFalse: this.#value(op.whenFalse)
        });
        return;
      case "value.project":
        this.#ops.push({ ...op, value: this.#value(op.value) });
        return;
      case "value.compare":
        this.#ops.push({ ...op, a: this.#value(op.a), b: this.#value(op.b) });
        return;
      case "flags.set":
        this.#ops.push({
          ...op,
          inputs: Object.fromEntries(
            Object.entries(op.inputs).map(([name, value]) => [name, this.#value(value)])
          )
        });
        return;
      case "flags.write":
        this.#ops.push({
          ...op,
          cells: Object.fromEntries(
            Object.entries(op.cells).map(([flag, cell]) => [
              flag,
              cell.kind === "expr" ? { kind: "expr", value: this.#value(cell.value) } : cell
            ])
          ),
          ...(op.conditions === undefined
            ? {}
            : {
                conditions: Object.fromEntries(
                  Object.entries(op.conditions).map(([cc, value]) => [cc, this.#value(value)])
                )
              })
        });
        return;
      case "flags.condition":
        this.#ops.push(op);
        return;
      case "next":
        this.#ops.push(op);
        return;
      case "jump":
        this.#ops.push({ ...op, target: this.#value(op.target) });
        return;
      case "conditionalJump":
        this.#ops.push({
          ...op,
          condition: this.#value(op.condition),
          taken: this.#value(op.taken),
          notTaken: this.#value(op.notTaken)
        });
        return;
      case "hostTrap":
        this.#ops.push({
          ...op,
          vector: this.#value(op.vector)
        });
        return;
    }
  }

  #appendGet(op: Extract<IrOp, { op: "get" }>): void {
    if (op.source.kind !== "operand") {
      this.#ops.push({
        ...op,
        source: this.#storage(op.source)
      });
      return;
    }

    const binding = this.#operandBinding(op.source.index);

    switch (binding.kind) {
      case "static.reg":
        this.#ops.push({
          ...op,
          source: regRefForAlias(binding.alias),
          accessWidth: op.accessWidth ?? binding.alias.width
        });
        return;
      case "static.mem":
        this.#ops.push({
          ...op,
          source: { kind: "mem", address: this.#addressForOperand(op.source, binding.ea) }
        });
        return;
      case "static.imm32":
        this.#ops.push({
          op: "value.const",
          type: "i32",
          dst: op.dst,
          value: constReadValue(binding.value, op.accessWidth ?? 32)
        });
        return;
      case "static.relTarget":
        this.#ops.push({
          op: "value.const",
          type: "i32",
          dst: op.dst,
          value: constReadValue(binding.target, op.accessWidth ?? 32)
        });
        return;
    }
  }

  #appendSet(op: Extract<IrOp, { op: "set" }>): void {
    if (op.target.kind !== "operand") {
      this.#ops.push({
        ...op,
        target: this.#storage(op.target),
        value: this.#value(op.value)
      });
      return;
    }

    const binding = this.#operandBinding(op.target.index);

    switch (binding.kind) {
      case "static.reg":
        this.#ops.push({
          ...op,
          target: regRefForAlias(binding.alias),
          value: this.#value(op.value),
          accessWidth: op.accessWidth ?? binding.alias.width
        });
        return;
      case "static.mem":
        this.#ops.push({
          ...op,
          target: { kind: "mem", address: this.#addressForOperand(op.target, binding.ea) },
          value: this.#value(op.value)
        });
        return;
      case "static.imm32":
      case "static.relTarget":
        throw new Error(`cannot write immutable JIT operand ${op.target.index}`);
    }
  }

  #appendAddress(op: Extract<IrOp, { op: "address" }>): void {
    const binding = this.#operandBinding(op.operand.index);

    if (binding.kind !== "static.mem") {
      throw new Error(`JIT address operand ${op.operand.index} is not memory`);
    }

    this.#emitAddress(binding.ea, op.dst);
    this.#addressVarByOperandRef.set(op.operand, op.dst);
  }

  #storage(storage: StorageRef): StorageRef {
    switch (storage.kind) {
      case "operand":
        throw new Error(`unresolved JIT operand storage ${storage.index}`);
      case "reg":
        return storage;
      case "mem":
        return {
          kind: "mem",
          address: this.#value(storage.address)
        };
    }
  }

  #value(value: ValueRef): ValueRef {
    return value.kind === "nextEip"
      ? const32(this.#input.nextEip)
      : value;
  }

  #addressForOperand(operand: OperandRef, ea: EffectiveAddress): ValueRef {
    const existing = this.#addressVarByOperandRef.get(operand);

    if (existing !== undefined) {
      return existing;
    }

    const dst = this.#allocVar();

    this.#emitAddress(ea, dst);
    this.#addressVarByOperandRef.set(operand, dst);
    return dst;
  }

  #emitAddress(ea: EffectiveAddress, dst: VarRef): void {
    const terms: ValueRef[] = [];

    if (ea.base !== undefined) {
      terms.push(this.#emitRegisterRead(ea.base));
    }

    if (ea.index !== undefined) {
      const indexValue = this.#emitRegisterRead(ea.index);

      terms.push(ea.scale === 1
        ? indexValue
        : this.#emitBinary("shl", indexValue, const32(scaleShift(ea.scale))));
    }

    if (ea.disp !== 0 || terms.length === 0) {
      terms.push(const32(ea.disp));
    }

    if (terms.length === 1) {
      this.#materialize(terms[0]!, dst);
      return;
    }

    let current = terms[0]!;

    for (let index = 1; index < terms.length; index += 1) {
      const isLast = index === terms.length - 1;
      const addDst = isLast ? dst : this.#allocVar();

      this.#ops.push({
        op: "value.binary",
        type: "i32",
        operator: "add",
        dst: addDst,
        a: current,
        b: terms[index]!
      });
      current = addDst;
    }
  }

  #materialize(value: ValueRef, dst: VarRef): void {
    switch (value.kind) {
      case "const":
        this.#ops.push({ op: "value.const", type: value.type, dst, value: value.value });
        return;
      case "var":
        this.#ops.push({
          op: "value.binary",
          type: "i32",
          operator: "add",
          dst,
          a: value,
          b: const32(0)
        });
        return;
      case "nextEip":
        this.#ops.push({ op: "value.const", type: "i32", dst, value: u32(this.#input.nextEip) });
        return;
    }
  }

  #emitRegisterRead(reg: Reg32): VarRef {
    const dst = this.#allocVar();

    this.#ops.push({
      op: "get",
      dst,
      source: { kind: "reg", reg },
      accessWidth: 32
    });
    return dst;
  }

  #emitBinary(operator: IrBinaryOperator, a: ValueRef, b: ValueRef): VarRef {
    const dst = this.#allocVar();

    this.#ops.push({
      op: "value.binary",
      type: "i32",
      operator,
      dst,
      a,
      b
    });
    return dst;
  }

  #operandBinding(index: number): JitOperandBinding {
    const binding = this.#input.operands[index];

    if (binding === undefined) {
      throw new Error(`missing JIT operand binding ${index}`);
    }

    return binding;
  }

  #allocVar(): VarRef {
    return this.#input.allocator.allocate();
  }
}

function regRefForAlias(alias: RegisterAlias): RegRef {
  return {
    kind: "reg",
    reg: alias.name
  };
}

function constReadValue(value: number, width: OperandWidth): number {
  if (width === 32) {
    return u32(value);
  }

  const mask = width === 16 ? 0xffff : 0xff;
  return value & mask;
}

function scaleShift(scale: EffectiveAddress["scale"]): 1 | 2 | 3 {
  switch (scale) {
    case 2:
      return 1;
    case 4:
      return 2;
    case 8:
      return 3;
    case 1:
      throw new Error("scale 1 does not need a shift");
  }
}
