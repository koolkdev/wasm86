import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { ResourceByteOperand, ResourceEffect } from "#compiler/ir/resource.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { isConcreteFlagStateField } from "#core/flags/layout.js";
import {
  BoundStateAccess,
  StateAccess
} from "#core/state/access.js";
import type { SegmentStateField } from "#core/state/channels.js";
import type { InstructionStateChannel } from "../state/channels.js";
import type { OperandWidth } from "#core/types.js";
import { cpuState } from "#cpu/state.js";
import type { Action, OpAction } from "#ir/actions.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { covers } from "#ir/aliasing.js";

type TestValueId = ValueId | number;
type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;

export type StateReadAction = OpAction & Readonly<{
  op: OperationOf<"resource.read">;
  output: ValueId;
}>;

export type StateWriteAction = OpAction & Readonly<{
  op: OperationOf<"resource.write">;
}>;

export function stateRead(
  values: ValueTable,
  output: TestValueId,
  channel: InstructionStateChannel,
  signed?: true
): StateReadAction {
  return readAction(
    output,
    channelOperand(accessFor(values), channel),
    signed,
    channel.kind === "field" && isConcreteFlagStateField(channel)
  );
}

export function dynamicGprRead(
  values: ValueTable,
  output: TestValueId,
  index: ValueId,
  width: OperandWidth,
  signed?: true
): StateReadAction {
  return readAction(output, accessFor(values).dynamicGpr(index, width), signed);
}

export function dynamicSegmentRead(
  values: ValueTable,
  output: TestValueId,
  index: ValueId,
  field: SegmentStateField
): StateReadAction {
  return readAction(output, accessFor(values).dynamicSegment(index, field));
}

export function stateWrite(
  values: ValueTable,
  channel: InstructionStateChannel,
  value: TestValueId
): StateWriteAction {
  return writeAction(channelOperand(accessFor(values), channel), value);
}

export function dynamicGprWrite(
  values: ValueTable,
  index: ValueId,
  width: OperandWidth,
  value: TestValueId
): StateWriteAction {
  return writeAction(accessFor(values).dynamicGpr(index, width), value);
}

export function stateEffect(
  values: ValueTable,
  channel: InstructionStateChannel
): ResourceEffect {
  return channelOperand(accessFor(values), channel).effect;
}

export function dynamicGprEffect(
  values: ValueTable,
  index: ValueId,
  width: OperandWidth
): ResourceEffect {
  return accessFor(values).dynamicGpr(index, width).effect;
}

export function dynamicSegmentEffect(
  values: ValueTable,
  index: ValueId,
  field: SegmentStateField
): ResourceEffect {
  return accessFor(values).dynamicSegment(index, field).effect;
}

export function readsStateChannel(
  values: ValueTable,
  action: Action,
  channel: InstructionStateChannel
): action is StateReadAction {
  return isStateRead(action) && effectsEqual(
    action.op.effect,
    stateEffect(values, channel)
  );
}

export function writesStateChannel(
  values: ValueTable,
  action: Action,
  channel: InstructionStateChannel
): action is StateWriteAction {
  return isStateWrite(action) && effectsEqual(
    action.op.effect,
    stateEffect(values, channel)
  );
}

export function readsDynamicGpr(
  values: ValueTable,
  action: Action,
  index: ValueId,
  width: OperandWidth
): action is StateReadAction {
  return isStateRead(action) && effectsEqual(
    action.op.effect,
    dynamicGprEffect(values, index, width)
  );
}

export function writesDynamicGpr(
  values: ValueTable,
  action: Action,
  index: ValueId,
  width: OperandWidth
): action is StateWriteAction {
  return isStateWrite(action) && effectsEqual(
    action.op.effect,
    dynamicGprEffect(values, index, width)
  );
}

export function readsDynamicSegment(
  values: ValueTable,
  action: Action,
  index: ValueId,
  field: SegmentStateField
): action is StateReadAction {
  return isStateRead(action) && effectsEqual(
    action.op.effect,
    dynamicSegmentEffect(values, index, field)
  );
}

export function stateEffectsEqual(
  left: ResourceEffect,
  right: ResourceEffect
): boolean {
  return effectsEqual(left, right);
}

export function isStateRead(
  action: Action
): action is StateReadAction {
  return action.kind === "op" &&
    action.op.kind === "resource.read" &&
    action.op.effect.resource === cpuState.resource &&
    action.output !== undefined;
}

export function isStateWrite(
  action: Action
): action is StateWriteAction {
  return action.kind === "op" &&
    action.op.kind === "resource.write" &&
    action.op.effect.resource === cpuState.resource;
}

export function stateWriteValue(
  action: StateWriteAction
): ValueId {
  const input = action.op.inputs.at(-1);

  if (input === undefined) {
    throw new Error("state write has no value input");
  }
  return input.value;
}

function readAction(
  output: TestValueId,
  source: ResourceByteOperand,
  signed?: true,
  singleBit = false
): StateReadAction {
  const op = signed === true
    ? resourceRead.create({ source, mode: { kind: "signed" } })
    : resourceRead.create(
        singleBit
          ? {
              source,
              mode: { kind: "unsigned", bounds: fitsUnsigned(1) }
            }
          : { source }
      );

  return { kind: "op", output: valueId(output), op };
}

function writeAction(
  destination: ResourceByteOperand,
  value: TestValueId
): StateWriteAction {
  return {
    kind: "op",
    op: resourceWrite.create({ destination, value: valueId(value) })
  };
}

function accessFor(values: ValueTable): BoundStateAccess {
  return new StateAccess(cpuState).bind(new RegionBuilder(values));
}

function channelOperand(
  access: BoundStateAccess,
  channel: InstructionStateChannel
): ResourceByteOperand {
  switch (channel.kind) {
    case "field":
      return access.field(channel);
    case "gpr":
      return access.gprChannel(channel);
    case "segment":
      return access.segment(channel.reg, channel.field);
  }
}

function effectsEqual(left: ResourceEffect, right: ResourceEffect): boolean {
  return covers(left, right) && covers(right, left);
}
