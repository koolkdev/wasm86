import {
  type ResourceReadOperation,
  type ResourceWriteOperation
} from "#compiler/function/operation.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { InstructionStateChannel } from "../state/channels.js";
import { cpuState, cpuStateAccess } from "#test/support/execution-model.js";
import type { RegionNode } from "#compiler/function/region.js";
import { covers } from "#compiler/function/storage.js";

export type StateReadOperation = ResourceReadOperation;
export type StateWriteOperation = ResourceWriteOperation;

export function stateEffect(channel: InstructionStateChannel): ResourceEffect {
  switch (channel.kind) {
    case "field":
      return cpuStateAccess.fieldEffect(channel);
    case "gpr":
      return cpuStateAccess.gprEffect(channel);
    case "segment":
      return cpuStateAccess.segmentEffect(channel.reg, channel.field);
  }
}

export function readsStateChannel(
  node: RegionNode,
  channel: InstructionStateChannel
): node is StateReadOperation {
  return isStateRead(node) && effectsEqual(node.source.effect, stateEffect(channel));
}

export function writesStateChannel(
  node: RegionNode,
  channel: InstructionStateChannel
): node is StateWriteOperation {
  return isStateWrite(node) && effectsEqual(node.destination.effect, stateEffect(channel));
}

export function isStateRead(node: RegionNode): node is StateReadOperation {
  return node.kind === "resource.read" && node.source.effect.resource === cpuState.resource;
}

export function isStateWrite(node: RegionNode): node is StateWriteOperation {
  return node.kind === "resource.write" && node.destination.effect.resource === cpuState.resource;
}

export function stateWriteValue(operation: StateWriteOperation): ValueRef {
  return operation.value;
}

function effectsEqual(left: ResourceEffect, right: ResourceEffect): boolean {
  return covers(left, right) && covers(right, left);
}
