import {
  type ResourceReadOperation,
  type ResourceWriteOperation
} from "#compiler/ir/operations/resource.js";
import type { ResourceByteOperand, ResourceEffect } from "#compiler/ir/resource.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  BoundStateAccess,
  StateAccess
} from "#core/state/access.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { cpuState } from "#test/support/execution-model.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import { covers } from "#compiler/ir/effects.js";

export type StateReadOperation = ResourceReadOperation;
export type StateWriteOperation = ResourceWriteOperation;

export function stateEffect(
  values: ValueTable,
  channel: InstructionStateChannel
): ResourceEffect {
  return channelOperand(accessFor(values), channel).effect;
}

export function readsStateChannel(
  values: ValueTable,
  node: RegionNode,
  channel: InstructionStateChannel
): node is StateReadOperation {
  return isStateRead(node) && effectsEqual(
    node.effect,
    stateEffect(values, channel)
  );
}

export function writesStateChannel(
  values: ValueTable,
  node: RegionNode,
  channel: InstructionStateChannel
): node is StateWriteOperation {
  return isStateWrite(node) && effectsEqual(
    node.effect,
    stateEffect(values, channel)
  );
}

export function isStateRead(
  node: RegionNode
): node is StateReadOperation {
  return node.kind === "resource.read" &&
    node.effect.resource === cpuState.resource &&
    node.outputs.length === 1;
}

export function isStateWrite(
  node: RegionNode
): node is StateWriteOperation {
  return node.kind === "resource.write" &&
    node.effect.resource === cpuState.resource;
}

export function stateWriteValue(
  operation: StateWriteOperation
): ValueId {
  return operation.inputs[1].value;
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
