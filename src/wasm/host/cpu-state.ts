import type { MutableCpuStateView } from "#core/state/cpu-state.js";
import {
  createCoreStateHostView,
  type CoreStateHostView
} from "#core/state/host-view.js";
import {
  createFlagStateHostView,
  type FlagStateHostView
} from "#core/flags/host-view.js";
import type { X86Flag } from "#core/flags/definitions.js";
import {
  createCpuExecutionStateHostView,
  type CpuExecutionStateHostView
} from "#cpu/execution-state.js";
import type { Reg32, SegmentRegister } from "#core/types.js";
import { executionStateLayout } from "#ir/state-layout.js";

type WasmCpuStateFieldBinding =
  | Readonly<{ kind: "gpr"; reg: Reg32 }>
  | Readonly<{ kind: "eip" }>
  | Readonly<{ kind: "instructionCount" }>
  | Readonly<{ kind: "lazyKind" }>
  | Readonly<{ kind: "lazyA" }>
  | Readonly<{ kind: "lazyB" }>
  | Readonly<{ kind: "flag"; flag: X86Flag }>
  | Readonly<{
      kind: "segmentSelector" | "segmentBase" | "segmentLimit" | "segmentAccess";
      reg: SegmentRegister;
    }>;

// This compatibility view alone owns the legacy semantic snapshot vocabulary.
// Every binding delegates to the relevant owner view; none carries placement.
const wasmCpuStateFieldBindings = {
  eax: { kind: "gpr", reg: "eax" },
  ecx: { kind: "gpr", reg: "ecx" },
  edx: { kind: "gpr", reg: "edx" },
  ebx: { kind: "gpr", reg: "ebx" },
  esp: { kind: "gpr", reg: "esp" },
  ebp: { kind: "gpr", reg: "ebp" },
  esi: { kind: "gpr", reg: "esi" },
  edi: { kind: "gpr", reg: "edi" },
  eip: { kind: "eip" },
  instructionCount: { kind: "instructionCount" },
  lazyFlagsKind: { kind: "lazyKind" },
  lazyFlagsA: { kind: "lazyA" },
  lazyFlagsB: { kind: "lazyB" },
  CF: { kind: "flag", flag: "CF" },
  PF: { kind: "flag", flag: "PF" },
  AF: { kind: "flag", flag: "AF" },
  ZF: { kind: "flag", flag: "ZF" },
  SF: { kind: "flag", flag: "SF" },
  OF: { kind: "flag", flag: "OF" },
  DF: { kind: "flag", flag: "DF" },
  TF: { kind: "flag", flag: "TF" },
  NT: { kind: "flag", flag: "NT" },
  AC: { kind: "flag", flag: "AC" },
  ID: { kind: "flag", flag: "ID" },
  esSelector: { kind: "segmentSelector", reg: "es" },
  csSelector: { kind: "segmentSelector", reg: "cs" },
  ssSelector: { kind: "segmentSelector", reg: "ss" },
  dsSelector: { kind: "segmentSelector", reg: "ds" },
  fsSelector: { kind: "segmentSelector", reg: "fs" },
  gsSelector: { kind: "segmentSelector", reg: "gs" },
  esBase: { kind: "segmentBase", reg: "es" },
  csBase: { kind: "segmentBase", reg: "cs" },
  ssBase: { kind: "segmentBase", reg: "ss" },
  dsBase: { kind: "segmentBase", reg: "ds" },
  fsBase: { kind: "segmentBase", reg: "fs" },
  gsBase: { kind: "segmentBase", reg: "gs" },
  esLimit: { kind: "segmentLimit", reg: "es" },
  csLimit: { kind: "segmentLimit", reg: "cs" },
  ssLimit: { kind: "segmentLimit", reg: "ss" },
  dsLimit: { kind: "segmentLimit", reg: "ds" },
  fsLimit: { kind: "segmentLimit", reg: "fs" },
  gsLimit: { kind: "segmentLimit", reg: "gs" },
  esAccess: { kind: "segmentAccess", reg: "es" },
  csAccess: { kind: "segmentAccess", reg: "cs" },
  ssAccess: { kind: "segmentAccess", reg: "ss" },
  dsAccess: { kind: "segmentAccess", reg: "ds" },
  fsAccess: { kind: "segmentAccess", reg: "fs" },
  gsAccess: { kind: "segmentAccess", reg: "gs" }
} as const satisfies Readonly<Record<string, WasmCpuStateFieldBinding>>;

export type WasmCpuStateField = keyof typeof wasmCpuStateFieldBindings;
export const wasmCpuStateFields = Object.keys(
  wasmCpuStateFieldBindings
) as readonly WasmCpuStateField[];

export type WasmCpuStateSnapshot = Record<WasmCpuStateField, number>;
export type WasmCpuStateInit = Partial<WasmCpuStateSnapshot>;

export class WasmCpuState implements MutableCpuStateView {
  readonly #core: CoreStateHostView;
  readonly #flags: FlagStateHostView;
  readonly #execution: CpuExecutionStateHostView;

  constructor(readonly memory: WebAssembly.Memory) {
    if (memory.buffer.byteLength < executionStateLayout.byteLength) {
      throw new RangeError(
        `cpu state memory is too small: ${memory.buffer.byteLength} < ${executionStateLayout.byteLength}`
      );
    }

    this.#core = createCoreStateHostView(memory, executionStateLayout);
    this.#flags = createFlagStateHostView(memory, executionStateLayout);
    this.#execution = createCpuExecutionStateHostView(memory, executionStateLayout);
  }

  readReg32(reg: Reg32): number {
    return this.#core.readReg32(reg);
  }

  writeReg32(reg: Reg32, value: number): void {
    this.#core.writeReg32(reg, value);
  }

  readSegmentSelector(reg: SegmentRegister): number {
    return this.#core.readSegmentSelector(reg);
  }

  writeSegmentSelector(reg: SegmentRegister, value: number): void {
    this.#core.writeSegmentSelector(reg, value);
  }

  readSegmentBase(reg: SegmentRegister): number {
    return this.#core.readSegmentBase(reg);
  }

  writeSegmentBase(reg: SegmentRegister, value: number): void {
    this.#core.writeSegmentBase(reg, value);
  }

  readSegmentLimit(reg: SegmentRegister): number {
    return this.#core.readSegmentLimit(reg);
  }

  writeSegmentLimit(reg: SegmentRegister, value: number): void {
    this.#core.writeSegmentLimit(reg, value);
  }

  readSegmentAccess(reg: SegmentRegister): number {
    return this.#core.readSegmentAccess(reg);
  }

  writeSegmentAccess(reg: SegmentRegister, value: number): void {
    this.#core.writeSegmentAccess(reg, value);
  }

  readFlag(flag: X86Flag): boolean {
    return this.#flags.readFlag(flag);
  }

  writeFlag(flag: X86Flag, value: boolean): void {
    this.#flags.writeFlag(flag, value);
  }

  load(state: WasmCpuStateInit): void {
    for (const field of wasmCpuStateFields) {
      this.#writeField(field, state[field] ?? 0);
    }
  }

  get eip(): number {
    return this.#core.eip;
  }

  set eip(value: number) {
    this.#core.eip = value;
  }

  get instructionCount(): number {
    return this.#execution.instructionCount;
  }

  #writeField(field: WasmCpuStateField, value: number): void {
    const binding: WasmCpuStateFieldBinding = wasmCpuStateFieldBindings[field];

    switch (binding.kind) {
      case "gpr":
        this.#core.writeReg32(binding.reg, value);
        return;
      case "eip":
        this.#core.eip = value;
        return;
      case "instructionCount":
        this.#execution.instructionCount = value;
        return;
      case "lazyKind":
        this.#flags.lazyKind = value;
        return;
      case "lazyA":
        this.#flags.lazyA = value;
        return;
      case "lazyB":
        this.#flags.lazyB = value;
        return;
      case "flag":
        this.#flags.writeFlagByte(binding.flag, value);
        return;
      case "segmentSelector":
        this.#core.writeSegmentSelector(binding.reg, value);
        return;
      case "segmentBase":
        this.#core.writeSegmentBase(binding.reg, value);
        return;
      case "segmentLimit":
        this.#core.writeSegmentLimit(binding.reg, value);
        return;
      case "segmentAccess":
        this.#core.writeSegmentAccess(binding.reg, value);
        return;
    }
  }
}
