import type { LayoutHostView } from "#compiler/layout/host-view.js";
import type { Reg32, SegmentRegister } from "#core/types.js";
import { coreStateFields } from "./layout.js";
import type { MutableCoreStateView } from "./view.js";

export function createCoreStateHostView(
  storage: LayoutHostView
): MutableCoreStateView {
  return new CoreStateHostViewImpl(storage);
}

class CoreStateHostViewImpl implements MutableCoreStateView {
  readonly #storage: LayoutHostView;

  constructor(storage: LayoutHostView) {
    this.#storage = storage;
  }

  get eip(): number {
    return this.#storage.readField(coreStateFields.eip);
  }

  set eip(value: number) {
    this.#storage.writeField(coreStateFields.eip, value);
  }

  readReg32(reg: Reg32): number {
    return this.#storage.readNamedArrayElement(coreStateFields.gprs, reg);
  }

  writeReg32(reg: Reg32, value: number): void {
    this.#storage.writeNamedArrayElement(coreStateFields.gprs, reg, value);
  }

  readSegmentSelector(reg: SegmentRegister): number {
    return this.#storage.readNamedArrayElement(coreStateFields.segmentSelectors, reg);
  }

  writeSegmentSelector(reg: SegmentRegister, value: number): void {
    this.#storage.writeNamedArrayElement(coreStateFields.segmentSelectors, reg, value);
  }

  readSegmentBase(reg: SegmentRegister): number {
    return this.#storage.readNamedArrayElement(coreStateFields.segmentBases, reg);
  }

  writeSegmentBase(reg: SegmentRegister, value: number): void {
    this.#storage.writeNamedArrayElement(coreStateFields.segmentBases, reg, value);
  }

  readSegmentLimit(reg: SegmentRegister): number {
    return this.#storage.readNamedArrayElement(coreStateFields.segmentLimits, reg);
  }

  writeSegmentLimit(reg: SegmentRegister, value: number): void {
    this.#storage.writeNamedArrayElement(coreStateFields.segmentLimits, reg, value);
  }

  readSegmentAccess(reg: SegmentRegister): number {
    return this.#storage.readNamedArrayElement(coreStateFields.segmentAccess, reg);
  }

  writeSegmentAccess(reg: SegmentRegister, value: number): void {
    this.#storage.writeNamedArrayElement(coreStateFields.segmentAccess, reg, value);
  }
}
