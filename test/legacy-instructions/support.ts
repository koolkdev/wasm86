import { test } from "node:test";

import {
  assertInstructionFixtureResult,
  prepareInstructionFixture,
  type InstructionFixture
} from "#test/support/instruction-fixture.js";

export function registerInstructionFixture(fixture: InstructionFixture): void {
  test(`Cpu executes ${fixture.name}`, () => {
    const machine = prepareInstructionFixture(fixture);
    const stop = machine.cpu.run({ instructionBudget: 100 });

    assertInstructionFixtureResult(fixture, stop, machine);
  });
}

export function registerInstructionFixtures(
  fixtures: readonly InstructionFixture[]
): void {
  for (const fixture of fixtures) {
    registerInstructionFixture(fixture);
  }
}
