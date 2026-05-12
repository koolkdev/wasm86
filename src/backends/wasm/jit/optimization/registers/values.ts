import type { OperandWidth, RegisterAlias, Reg32 } from "#x86/isa/types.js";
import type { OperandRef, StorageRef } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitValue } from "#backends/wasm/jit/ir/values.js";
import {
  jitStorageHasRegisterValue,
  jitRegisterValuesReadByEffectiveAddress,
  jitValueReadsReg,
  jitValueUsesSymbolicReg,
  jitValueForEffectiveAddress,
  jitValueForStorage
} from "#backends/wasm/jit/ir/values.js";
import {
  createRegisterAccessState,
  writeRegisterAccess,
  type JitRegisterAccessState
} from "#backends/wasm/jit/ir/register-prefix-values.js";

export class JitRegisterValues {
  #values = new Map<Reg32, JitRegisterAccessState>();

  get trackedValues(): ReadonlyMap<Reg32, JitValue> {
    return new Map(this.#fullValueEntries());
  }

  get trackedRegisterValues(): ReadonlyMap<Reg32, JitRegisterAccessState> {
    return this.#values;
  }

  get size(): number {
    return this.#values.size;
  }

  entries(): IterableIterator<[Reg32, JitValue]> {
    return this.trackedValues.entries();
  }

  get(reg: Reg32): JitValue | undefined {
    const prefix = this.#values.get(reg)?.prefix;

    return prefix?.width === 32 ? prefix.value : undefined;
  }

  has(reg: Reg32): boolean {
    return this.#values.has(reg);
  }

  hasStorageValue(
    storage: StorageRef,
    operands: readonly JitOperandBinding[],
    accessWidth: OperandWidth = 32
  ): boolean {
    return jitStorageHasRegisterValue(storage, operands, this.#values, accessWidth);
  }

  valueForEffectiveAddress(
    operand: OperandRef,
    operands: readonly JitOperandBinding[]
  ): JitValue | undefined {
    return jitValueForEffectiveAddress(operand, operands, this.#values);
  }

  valueForStorage(
    storage: StorageRef,
    operands: readonly JitOperandBinding[],
    accessWidth: OperandWidth = 32,
    signed = false
  ): JitValue | undefined {
    return jitValueForStorage(storage, operands, this.#values, accessWidth, signed);
  }

  regsReadByEffectiveAddress(
    operand: OperandRef,
    operands: readonly JitOperandBinding[]
  ): readonly Reg32[] {
    return jitRegisterValuesReadByEffectiveAddress(operand, operands, this.#values);
  }

  set(reg: Reg32, value: JitValue): void {
    writeRegisterAccess(this.#writableState(reg), 32, 0, value);
  }

  write(
    reg: Reg32,
    width: OperandWidth,
    bitOffset: RegisterAlias["bitOffset"],
    value: JitValue
  ): void {
    writeRegisterAccess(this.#writableState(reg), width, bitOffset, value);
  }

  delete(reg: Reg32): void {
    this.#values.delete(reg);
  }

  deletePartialDependencies(
    clobberedReg: Reg32,
    options: Readonly<{ includeSymbolicRegs?: boolean }> = {}
  ): void {
    for (const [reg, state] of this.#values) {
      const prefix = state.prefix;

      if (prefix === undefined || prefix.width === 32) {
        continue;
      }

      if (
        jitValueReadsReg(prefix.value, clobberedReg) ||
        (options.includeSymbolicRegs === true && jitValueUsesSymbolicReg(prefix.value, clobberedReg))
      ) {
        this.delete(reg);
      }
    }
  }

  clear(): void {
    this.#values.clear();
  }

  #writableState(reg: Reg32): JitRegisterAccessState {
    const existing = this.#values.get(reg);

    if (existing !== undefined) {
      return existing;
    }

    const state = createRegisterAccessState();

    this.#values.set(reg, state);
    return state;
  }

  #fullValueEntries(): readonly [Reg32, JitValue][] {
    return [...this.#values].flatMap(([reg, state]) =>
      state.prefix?.width === 32 ? [[reg, state.prefix.value]] : []
    );
  }
}
