import { deepStrictEqual, strictEqual } from "node:assert";

import { x86Flags, type X86Flag } from "#core/flags/definitions.js";
import {
  reg32,
  segmentRegisters,
  type Reg32,
  type SegmentRegister
} from "#core/types.js";
import type { RunStop } from "#cpu/cpu.js";
import { createMachine, type Machine } from "#machine/machine.js";
import { startAddress } from "#test/support/addresses.js";

export type MemoryPatch = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

type SegmentBaseField = `${SegmentRegister}Base`;
type SegmentSelectorField = `${SegmentRegister}Selector`;

type ArchitecturalStateFields = Partial<
  Record<Reg32 | X86Flag | SegmentBaseField | SegmentSelectorField, number>
>;

export type InstructionFixtureInitialState = Readonly<
  ArchitecturalStateFields & {
    eip: number;
  }
>;

export type InstructionFixtureExpectedState = Readonly<
  ArchitecturalStateFields & {
    eip?: number;
    instructionCount?: number;
  }
>;

export type InstructionFixture = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState: InstructionFixtureInitialState;
  initialMemory?: readonly MemoryPatch[];
  expected: InstructionExpectation;
}>;

export type InstructionExpectation = Readonly<{
  stop: RunStop;
  state: InstructionFixtureExpectedState;
  memory?: readonly MemoryPatch[];
}>;

const fixtureMemoryByteLength = 0x1_0000;

export function prepareInstructionFixture(fixture: InstructionFixture): Machine {
  const machine = createMachine({ memoryByteLength: fixtureMemoryByteLength });
  const memory = new Uint8Array(machine.memory.buffer);

  writeMemoryPatches(memory, fixture.initialMemory ?? []);
  memory.set(fixture.bytes, startAddress);
  writeInitialState(machine, fixture.initialState);

  return machine;
}

export function assertInstructionFixtureResult(
  fixture: InstructionFixture,
  stop: RunStop,
  machine: Machine
): void {
  deepStrictEqual(stop, fixture.expected.stop, `${fixture.name}: expected stop`);
  assertStateFields(fixture, machine);
  assertMemoryPatches(
    new Uint8Array(machine.memory.buffer),
    fixture.expected.memory ?? []
  );
}

function writeInitialState(
  machine: Machine,
  initialState: InstructionFixtureInitialState
): void {
  const { state } = machine.cpu;

  state.eip = initialState.eip;

  for (const register of reg32) {
    const value = initialState[register];

    if (value !== undefined) {
      state.writeReg32(register, value);
    }
  }

  for (const flag of x86Flags) {
    const value = initialState[flag];

    if (value !== undefined) {
      state.writeFlag(flag, value !== 0);
    }
  }

  for (const segment of segmentRegisters) {
    const selectorField = `${segment}Selector` as const;
    const selector = initialState[selectorField];

    if (selector !== undefined) {
      state.writeSegmentSelector(segment, selector);
    }

    const baseField = `${segment}Base` as const;
    const base = initialState[baseField];

    if (base !== undefined) {
      state.writeSegmentBase(segment, base);
    }
  }
}

function assertStateFields(
  fixture: InstructionFixture,
  machine: Machine
): void {
  const { state } = machine.cpu;
  const expected = fixture.expected.state;

  assertExpectedScalar(fixture, expected, "eip", state.eip);
  assertExpectedScalar(
    fixture,
    expected,
    "instructionCount",
    state.instructionCount
  );

  for (const register of reg32) {
    assertExpectedScalar(
      fixture,
      expected,
      register,
      state.readReg32(register)
    );
  }

  for (const flag of x86Flags) {
    assertExpectedScalar(
      fixture,
      expected,
      flag,
      state.readFlag(flag) ? 1 : 0
    );
  }

  for (const segment of segmentRegisters) {
    const selectorField = `${segment}Selector` as const;
    assertExpectedScalar(
      fixture,
      expected,
      selectorField,
      state.readSegmentSelector(segment)
    );

    const baseField = `${segment}Base` as const;
    assertExpectedScalar(
      fixture,
      expected,
      baseField,
      state.readSegmentBase(segment)
    );
  }
}

function assertExpectedScalar(
  fixture: InstructionFixture,
  expected: InstructionFixtureExpectedState,
  field: keyof InstructionFixtureExpectedState,
  actual: number
): void {
  const expectedValue = expected[field];

  if (expectedValue !== undefined) {
    strictEqual(
      actual,
      expectedValue,
      `${fixture.name}: expected state.${field}`
    );
  }
}

function assertMemoryPatches(
  memory: Uint8Array,
  patches: readonly MemoryPatch[]
): void {
  for (const patch of patches) {
    for (let index = 0; index < patch.bytes.length; index += 1) {
      const address = patch.address + index;
      strictEqual(
        memory[address],
        patch.bytes[index],
        `expected memory byte at 0x${address.toString(16)}`
      );
    }
  }
}

function writeMemoryPatches(
  memory: Uint8Array,
  patches: readonly MemoryPatch[]
): void {
  for (const patch of patches) {
    memory.set(patch.bytes, patch.address);
  }
}
