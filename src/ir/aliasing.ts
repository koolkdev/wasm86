import { channelCovers, channelsOverlap, isDynamicSlot } from "./slots.js";
import type { Action } from "./actions.js";
import type { Body } from "./block.js";
import type {
  StorageEffects,
  StorageAccess
} from "#compiler/ir/effects.js";
import type { StateSlot } from "./slots.js";
import {
  type ByteRange,
  type ResourceEffect
} from "#compiler/ir/resource.js";

// One aliasing rule over the address spaces: static channels alias iff their
// byte ranges intersect; a dynamic GPR slot may alias every GPR word and a
// dynamic segment slot may alias every segment channel for the same field;
// compiler cells alias only their own opaque identity. Resource accesses use
// their resource identity plus the compiler-owned region/range algebra.
// Distinct spaces never alias.

const noEffects: StorageEffects = { reads: [], writes: [] };

// A control action's signature is the union over its bodies — any one may
// be selected. The union is for legality only; demand stays per-body.
export function effectsOf(action: Action): StorageEffects {
  switch (action.kind) {
    case "op":
      return action.op.effects;
    case "call":
      return action.target.effects;
    case "if":
      return bodyEffects(action.thenBody, action.elseBody);
    case "switch":
      return bodyEffects(...action.cases.map((switchCase) => switchCase.body), action.defaultBody);
    case "loop":
      return bodyEffects(action.body);
    case "loopContinue":
    case "finish":
    case "return":
      return noEffects;
  }
}

function bodyEffects(...bodies: readonly (Body | undefined)[]): StorageEffects {
  const reads: StorageAccess[] = [];
  const writes: StorageAccess[] = [];

  for (const body of bodies) {
    if (body === undefined) {
      continue;
    }

    for (const action of body.actions) {
      const effects = effectsOf(action);

      reads.push(...effects.reads);
      writes.push(...effects.writes);
    }
  }

  return { reads, writes };
}

export function mayAlias(a: StorageAccess, b: StorageAccess): boolean {
  switch (a.space) {
    case "state":
      return b.space === "state" && slotsMayAlias(a.slot, b.slot);
    case "cell":
      return b.space === "cell" && a.cell === b.cell;
    case "resource":
      return b.space === "resource" && resourceEffectsMayAlias(a, b);
  }
}

// Is every location in `covered` also in `covering`?
export function covers(covering: StorageAccess, covered: StorageAccess): boolean {
  switch (covering.space) {
    case "state":
      return covered.space === "state" && stateSlotCovers(covering.slot, covered.slot);
    case "cell":
      return covered.space === "cell" && covering.cell === covered.cell;
    case "resource":
      return covered.space === "resource" && resourceEffectCovers(covering, covered);
  }
}

export function slotsMayAlias(a: StateSlot, b: StateSlot): boolean {
  switch (a.kind) {
    case "gprDynamic":
      return b.kind === "gpr" || b.kind === "gprDynamic";
    case "segmentDynamic":
      return (b.kind === "segmentDynamic" || b.kind === "segment") && a.field === b.field;
    case "gpr":
      return isDynamicSlot(b) ? b.kind === "gprDynamic" : channelsOverlap(a, b);
    case "flag":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return !isDynamicSlot(b) && channelsOverlap(a, b);
    case "segment":
      return isDynamicSlot(b)
        ? b.kind === "segmentDynamic" && a.field === b.field
        : channelsOverlap(a, b);
  }
}

export function stateSlotCovers(covering: StateSlot, covered: StateSlot): boolean {
  if (isDynamicSlot(covering)) {
    if (covering.kind === "gprDynamic") {
      return (covered.kind === "gpr" && covering.byteLength === covered.byteLength) ||
        (covered.kind === "gprDynamic" && covering.byteLength === covered.byteLength);
    }
    return (covered.kind === "segment" && covering.field === covered.field) ||
      (covered.kind === "segmentDynamic" && covering.field === covered.field);
  }
  return !isDynamicSlot(covered) && channelCovers(covering, covered);
}

export function actionMayWriteStateSlot(action: Action, slot: StateSlot): boolean {
  switch (action.kind) {
    case "op":
      return action.op.effects.writes.some(
        (write) => write.space === "state" && slotsMayAlias(write.slot, slot)
      );
    case "call":
      return action.target.effects.writes.some(
        (write) => write.space === "state" && slotsMayAlias(write.slot, slot)
      );
    case "if":
      return bodyMayWriteStateSlot(action.thenBody, slot) ||
        (action.elseBody !== undefined && bodyMayWriteStateSlot(action.elseBody, slot));
    case "switch":
      return action.cases.some((switchCase) => bodyMayWriteStateSlot(switchCase.body, slot)) ||
        bodyMayWriteStateSlot(action.defaultBody, slot);
    case "loop":
      return bodyMayWriteStateSlot(action.body, slot);
    case "loopContinue":
    case "finish":
    case "return":
      return false;
  }
}

export function bodyMayWriteStateSlot(body: Body, slot: StateSlot): boolean {
  return body.actions.some((action) => actionMayWriteStateSlot(action, slot));
}

function resourceEffectsMayAlias(a: ResourceEffect, b: ResourceEffect): boolean {
  if (a.resource !== b.resource) {
    return false;
  }
  return byteRangesMayAlias(a.range, b.range);
}

function resourceEffectCovers(
  covering: ResourceEffect,
  covered: ResourceEffect
): boolean {
  if (covering.resource !== covered.resource) {
    return false;
  }
  return byteRangeCovers(covering.range, covered.range);
}

function byteRangesMayAlias(a: ByteRange, b: ByteRange): boolean {
  if (isWholeResource(a) || isWholeResource(b)) {
    return true;
  }
  if (!sameByteRangeBasis(a, b)) {
    return true;
  }
  if (a.slice === undefined || b.slice === undefined) {
    return true;
  }
  return intervalsOverlap(
    a.slice.byteOffset,
    a.slice.byteLength,
    b.slice.byteOffset,
    b.slice.byteLength
  );
}

function byteRangeCovers(covering: ByteRange, covered: ByteRange): boolean {
  if (isWholeResource(covering)) {
    return true;
  }
  if (!sameByteRangeBasis(covering, covered)) {
    return false;
  }
  if (covering.slice === undefined) {
    return true;
  }
  if (covered.slice === undefined) {
    return false;
  }
  return intervalContains(
    covering.slice.byteOffset,
    covering.slice.byteLength,
    covered.slice.byteOffset,
    covered.slice.byteLength
  );
}

function isWholeResource(range: ByteRange): boolean {
  return range.basis.kind === "resource" && range.slice === undefined;
}

function sameByteRangeBasis(a: ByteRange, b: ByteRange): boolean {
  if (a.basis.kind === "resource") {
    return b.basis.kind === "resource";
  }
  return b.basis.kind === "dynamic" && a.basis.origin === b.basis.origin;
}

function intervalsOverlap(
  aStart: number,
  aByteLength: number,
  bStart: number,
  bByteLength: number
): boolean {
  return aStart < bStart + bByteLength && bStart < aStart + aByteLength;
}

function intervalContains(
  outerStart: number,
  outerByteLength: number,
  innerStart: number,
  innerByteLength: number
): boolean {
  return outerStart <= innerStart &&
    innerStart + innerByteLength <= outerStart + outerByteLength;
}
