import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  createLayoutHostView,
  type LayoutHostView
} from "#compiler/layout/host-view.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import { createCpuStateHostView } from "#cpu/host-view.js";
import { x86Flags } from "#core/flags/definitions.js";
import {
  createFlagStateHostView,
  type FlagStateHostView
} from "#core/flags/host-view.js";
import { u32 } from "#core/numeric.js";
import { createCoreStateHostView } from "#core/state/host-view.js";
import type { MutableCoreStateView } from "#core/state/view.js";
import { reg32, segmentRegisters, type Reg32 } from "#core/types.js";
import { flagStateFields } from "#core/flags/layout.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { InstructionStateChannel } from "#core/instruction/state/channels.js";
import {
  gprChannel,
  segmentAccessChannel,
  segmentBaseChannel,
  segmentLimitChannel,
  segmentSelectorChannel
} from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import {
  wasmCpuStateFields,
  writeWasmCpuStateSnapshot,
  type WasmCpuStateField,
  type WasmCpuStateInit
} from "#test/support/cpu-state.js";
import {
  cpuStateAccess,
  testExecutionModel
} from "#test/support/execution-model.js";
import {
  completedTestFunction,
  testFunctionCompleted,
  instantiateTestFunction,
  type TestFunction
} from "./harness.js";

type OwnerViews = Readonly<{
  core: MutableCoreStateView;
  flags: FlagStateHostView;
  storage: LayoutHostView;
}>;

type AgreementCase = Readonly<{
  name: string;
  field: WasmCpuStateField;
  location: InstructionStateChannel;
  hostSeed: number;
  expectedGeneratedRead: number;
  generatedWrite: number;
  expectedHostRead: number;
  readHost(views: OwnerViews): number;
}>;

const fullMemberCases: AgreementCase[] = [];

for (const [index, reg] of reg32.entries()) {
  const hostSeed = u32(0x8123_4500 + index);
  const generatedWrite = 0x1_0000_0001 + index;

  fullMemberCases.push({
    name: reg,
    field: reg,
    location: gprChannel(reg),
    hostSeed,
    expectedGeneratedRead: hostSeed,
    generatedWrite,
    expectedHostRead: u32(generatedWrite),
    readHost: ({ core }) => core.readReg32(reg)
  });
}

fullMemberCases.push(
  {
    name: "eip",
    field: "eip",
    location: coreStateFields.eip,
    hostSeed: 0x89ab_cdef,
    expectedGeneratedRead: 0x89ab_cdef,
    generatedWrite: 0x1_2345_6789,
    expectedHostRead: 0x2345_6789,
    readHost: ({ core }) => core.eip
  },
  {
    name: "instructionCount",
    field: "instructionCount",
    location: instructionCountField,
    hostSeed: 0xfedc_ba98,
    expectedGeneratedRead: 0xfedc_ba98,
    generatedWrite: 0x1_7654_3210,
    expectedHostRead: 0x7654_3210,
    readHost: ({ storage }) => storage.readField(instructionCountField)
  },
  {
    name: "lazyFlagsKind",
    field: "lazyFlagsKind",
    location: flagStateFields.lazyKind,
    hostSeed: 0x1ab,
    expectedGeneratedRead: 0xab,
    generatedWrite: 0x2cd,
    expectedHostRead: 0xcd,
    readHost: ({ flags }) => flags.lazyKind
  },
  {
    name: "lazyFlagsA",
    field: "lazyFlagsA",
    location: flagStateFields.lazyA,
    hostSeed: 0xa1b2_c3d4,
    expectedGeneratedRead: 0xa1b2_c3d4,
    generatedWrite: 0x1_e5f6_0718,
    expectedHostRead: 0xe5f6_0718,
    readHost: ({ flags }) => flags.lazyA
  },
  {
    name: "lazyFlagsB",
    field: "lazyFlagsB",
    location: flagStateFields.lazyB,
    hostSeed: 0x192a_3b4c,
    expectedGeneratedRead: 0x192a_3b4c,
    generatedWrite: 0x1_5d6e_7f80,
    expectedHostRead: 0x5d6e_7f80,
    readHost: ({ flags }) => flags.lazyB
  }
);

for (const flag of x86Flags) {
  fullMemberCases.push({
    name: flag,
    field: flag,
    location: flagStateFields.concrete[flag],
    hostSeed: 0x80,
    expectedGeneratedRead: 1,
    generatedWrite: 0xfe,
    expectedHostRead: 1,
    readHost: ({ flags }) => flags.readFlag(flag) ? 1 : 0
  });
}

for (const [index, reg] of segmentRegisters.entries()) {
  const selectorField = `${reg}Selector` as WasmCpuStateField;
  const baseField = `${reg}Base` as WasmCpuStateField;
  const limitField = `${reg}Limit` as WasmCpuStateField;
  const accessField = `${reg}Access` as WasmCpuStateField;

  fullMemberCases.push(
    {
      name: selectorField,
      field: selectorField,
      location: segmentSelectorChannel(reg),
      hostSeed: 0x1_2300 + index,
      expectedGeneratedRead: 0x2300 + index,
      generatedWrite: 0x2_4500 + index,
      expectedHostRead: 0x4500 + index,
      readHost: ({ core }) => core.readSegmentSelector(reg)
    },
    {
      name: baseField,
      field: baseField,
      location: segmentBaseChannel(reg),
      hostSeed: u32(0x8100_0000 + index),
      expectedGeneratedRead: u32(0x8100_0000 + index),
      generatedWrite: 0x1_9100_0000 + index,
      expectedHostRead: u32(0x9100_0000 + index),
      readHost: ({ core }) => core.readSegmentBase(reg)
    },
    {
      name: limitField,
      field: limitField,
      location: segmentLimitChannel(reg),
      hostSeed: u32(0x8200_0000 + index),
      expectedGeneratedRead: u32(0x8200_0000 + index),
      generatedWrite: 0x1_9200_0000 + index,
      expectedHostRead: u32(0x9200_0000 + index),
      readHost: ({ core }) => core.readSegmentLimit(reg)
    },
    {
      name: accessField,
      field: accessField,
      location: segmentAccessChannel(reg),
      hostSeed: u32(0x8300_0000 + index),
      expectedGeneratedRead: u32(0x8300_0000 + index),
      generatedWrite: 0x1_9300_0000 + index,
      expectedHostRead: u32(0x9300_0000 + index),
      readHost: ({ core }) => core.readSegmentAccess(reg)
    }
  );
}

const narrowGprCases: readonly AgreementCase[] = [
  {
    name: "AL alias",
    field: "eax",
    location: gprChannel("al"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xdd,
    generatedWrite: 0x1234,
    expectedHostRead: 0xaabb_cc34,
    readHost: ({ core }) => core.readReg32("eax")
  },
  {
    name: "AH alias",
    field: "eax",
    location: gprChannel("ah"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xcc,
    generatedWrite: 0x1234,
    expectedHostRead: 0xaabb_34dd,
    readHost: ({ core }) => core.readReg32("eax")
  },
  {
    name: "AX alias",
    field: "eax",
    location: gprChannel("ax"),
    hostSeed: 0xaabb_ccdd,
    expectedGeneratedRead: 0xccdd,
    generatedWrite: 0x12_3456,
    expectedHostRead: 0xaabb_3456,
    readHost: ({ core }) => core.readReg32("eax")
  }
];

test("agreement cases cover every combined host-view field", () => {
  deepStrictEqual(
    [...new Set(fullMemberCases.map((entry) => entry.field))].sort(),
    [...wasmCpuStateFields].sort()
  );
});

for (const agreement of [...fullMemberCases, ...narrowGprCases]) {
  test(`host and generated state access agree for ${agreement.name}`, async () => {
    const destination = destinationFor(agreement.location);
    const block = agreementBlock(agreement.location, destination, agreement.generatedWrite);
    const { stateMemory, run } = await instantiateTestFunction(block);
    const combined = createCpuStateHostView(
      createLayoutHostView(stateMemory, testExecutionModel.cpuState.layout)
    );
    const initial: WasmCpuStateInit = {};

    initial[agreement.field] = agreement.hostSeed;
    writeWasmCpuStateSnapshot(new DataView(stateMemory.buffer), initial);

    strictEqual(run(), testFunctionCompleted, `${agreement.name}: generated block completed`);
    strictEqual(
      combined.core.readReg32(destination),
      agreement.expectedGeneratedRead,
      `${agreement.name}: generated read observed the host write`
    );
    strictEqual(
      agreement.readHost(ownerViews(stateMemory)),
      agreement.expectedHostRead,
      `${agreement.name}: owner host view observed the generated write`
    );
  });
}

function destinationFor(source: InstructionStateChannel): Reg32 {
  return source.kind === "gpr" && source.reg === "edi"
    ? "eax"
    : "edi";
}

function agreementBlock(
  source: InstructionStateChannel,
  destination: Reg32,
  generatedWrite: number
): TestFunction {
  return completedTestFunction(0, (fn) => {
    const state = cpuStateAccess.bind(fn.region);
    const generatedValue = fn.values.const(generatedWrite);
    const sourceOperand = stateOperand(state, source);
    const readOutput = state.read(sourceOperand);

    state.write(state.gpr(destination), readOutput);
    state.write(sourceOperand, generatedValue);
  });
}

function stateOperand(
  state: BoundStateAccess,
  channel: InstructionStateChannel
) {
  switch (channel.kind) {
    case "field":
      return state.field(channel);
    case "gpr":
      return state.gprChannel(channel);
    case "segment":
      return state.segment(channel.reg, channel.field);
  }
}

function ownerViews(memory: WebAssembly.Memory): OwnerViews {
  const storage = createLayoutHostView(
    memory,
    testExecutionModel.cpuState.layout
  );

  return {
    core: createCoreStateHostView(storage),
    flags: createFlagStateHostView(storage),
    storage
  };
}
