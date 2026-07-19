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
import type { BodyNode } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { covers } from "#ir/aliasing.js";

type TestValueId = ValueId | number;
type OperationOf<Kind extends Operation["kind"]> = Extract<Operation, { kind: Kind }>;

export type StateReadOperation = OperationOf<"resource.read"> & Readonly<{
  outputs: readonly [ValueId];
}>;

export type StateWriteOperation = OperationOf<"resource.write">;

export function stateRead(
  values: ValueTable,
  output: TestValueId,
  channel: InstructionStateChannel,
  signed?: true
): StateReadOperation {
  return readOperation(
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
): StateReadOperation {
  return readOperation(output, accessFor(values).dynamicGpr(index, width), signed);
}

export function dynamicSegmentRead(
  values: ValueTable,
  output: TestValueId,
  index: ValueId,
  field: SegmentStateField
): StateReadOperation {
  return readOperation(output, accessFor(values).dynamicSegment(index, field));
}

export function stateWrite(
  values: ValueTable,
  channel: InstructionStateChannel,
  value: TestValueId
): StateWriteOperation {
  return writeOperation(channelOperand(accessFor(values), channel), value);
}

export function dynamicGprWrite(
  values: ValueTable,
  index: ValueId,
  width: OperandWidth,
  value: TestValueId
): StateWriteOperation {
  return writeOperation(accessFor(values).dynamicGpr(index, width), value);
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
  node: BodyNode,
  channel: InstructionStateChannel
): node is StateReadOperation {
  return isStateRead(node) && effectsEqual(
    node.effect,
    stateEffect(values, channel)
  );
}

export function writesStateChannel(
  values: ValueTable,
  node: BodyNode,
  channel: InstructionStateChannel
): node is StateWriteOperation {
  return isStateWrite(node) && effectsEqual(
    node.effect,
    stateEffect(values, channel)
  );
}

export function readsDynamicGpr(
  values: ValueTable,
  node: BodyNode,
  index: ValueId,
  width: OperandWidth
): node is StateReadOperation {
  return isStateRead(node) && effectsEqual(
    node.effect,
    dynamicGprEffect(values, index, width)
  );
}

export function writesDynamicGpr(
  values: ValueTable,
  node: BodyNode,
  index: ValueId,
  width: OperandWidth
): node is StateWriteOperation {
  return isStateWrite(node) && effectsEqual(
    node.effect,
    dynamicGprEffect(values, index, width)
  );
}

export function readsDynamicSegment(
  values: ValueTable,
  node: BodyNode,
  index: ValueId,
  field: SegmentStateField
): node is StateReadOperation {
  return isStateRead(node) && effectsEqual(
    node.effect,
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
  node: BodyNode
): node is StateReadOperation {
  return node.kind === "resource.read" &&
    node.effect.resource === cpuState.resource &&
    node.outputs.length === 1;
}

export function isStateWrite(
  node: BodyNode
): node is StateWriteOperation {
  return node.kind === "resource.write" &&
    node.effect.resource === cpuState.resource;
}

export function stateWriteValue(
  operation: StateWriteOperation
): ValueId {
  const input = operation.inputs.at(-1);

  if (input === undefined) {
    throw new Error("state write has no value input");
  }
  return input.value;
}

function readOperation(
  output: TestValueId,
  source: ResourceByteOperand,
  signed?: true,
  singleBit = false
): StateReadOperation {
  const outputId = valueId(output);
  const operation = signed === true
    ? resourceRead.create({ source, mode: { kind: "signed" } }, () => outputId)
    : resourceRead.create(
        singleBit
          ? {
              source,
              mode: { kind: "unsigned", bounds: fitsUnsigned(1) }
            }
          : { source },
        () => outputId
      );

  return operation as StateReadOperation;
}

function writeOperation(
  destination: ResourceByteOperand,
  value: TestValueId
): StateWriteOperation {
  return resourceWrite.create(
    { destination, value: valueId(value) }
  );
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
