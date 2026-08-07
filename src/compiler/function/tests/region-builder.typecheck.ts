import type { RegionBuilder } from "../builder/region.js";
import type { CallTarget } from "../invocation.js";
import type { ResourceAccess } from "../resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { AnyValue, Integer, BitValue, I32Value, I64Value } from "../values.js";
import type { ValueRef } from "#compiler/function/values.js";

export function regionBuilderTypeContract(
  region: RegionBuilder,
  value32: I32Value,
  wide: I64Value,
  byte: Integer<8>,
  variable32: VariableRef<32>,
  wideVariable: VariableRef<64>,
  target: CallTarget,
  effect: ResourceEffect,
  storedId: ValueRef
): void {
  const inferred32: VariableRef<32> = region.variable(value32);
  const inferredWide: VariableRef<64> = region.variable(wide);
  const predicate = value32.ne(0);
  const inferredPredicate: VariableRef<1> = region.variable(predicate);
  const read32: I32Value = region.read(variable32);
  const readWide: I64Value = region.read(wideVariable);
  const operand: ResourceAccess<32> = {
    effect,
    address: { base: value32, displacement: 0 },
    width: 32,
    valueWidth: 32
  };
  const resourceValue: I32Value = region.readResource(operand);
  const joined: I32Value = region.ifValue(
    predicate,
    () => value32,
    () => read32
  );
  const switched: I32Value = region.switch(
    value32,
    [{ match: 1, build: () => value32 }],
    () => joined
  );
  const results: readonly AnyValue[] = region.call(target, [value32, wide]);
  const same32: boolean = region.sameValue(value32, read32);
  const differentWidths: boolean = region.sameValue(value32, wide);

  region.write(variable32, value32);
  region.write(wideVariable, wide);
  region.writeResource(operand, value32);
  region.if(predicate, () => {});
  region.switchControl(value32, [{ matches: [1], build: () => {} }], () => {});
  region.return([value32, wide]);
  region.returnCall(target, [value32, wide]);

  // @ts-expect-error an i32 variable rejects an i64 value.
  region.write(variable32, wide);
  // @ts-expect-error an i64 variable rejects an i32 value.
  region.write(wideVariable, value32);
  // @ts-expect-error resource writes must match the transfer width.
  region.writeResource(operand, wide);
  // @ts-expect-error control conditions are one bit.
  region.if(wide, () => {});
  region.ifValue(
    predicate,
    () => wide,
    // @ts-expect-error value-producing arms must return the same width.
    () => value32
  );
  // @ts-expect-error switch selectors are i32.
  region.switch(wide, [], () => value32);
  // @ts-expect-error stored IDs are not expression values.
  region.variable(storedId);
  // @ts-expect-error stored IDs are not control conditions.
  region.if(storedId, () => {});
  // @ts-expect-error stored IDs are not return values.
  region.return([storedId]);
  // @ts-expect-error full i32 values are not predicates.
  region.if(value32, () => {});
  // @ts-expect-error narrow integer values are not predicates.
  region.if(byte, () => {});

  void [
    inferred32,
    inferredWide,
    inferredPredicate,
    readWide,
    resourceValue,
    switched,
    results,
    same32,
    differentWidths
  ];
}

export function regionLoopTypeContract(
  region: RegionBuilder,
  firstSeed: I32Value,
  secondSeed: I32Value,
  wide: I64Value
): void {
  region.loop([firstSeed, secondSeed], (body, inputs) => {
    const first: I32Value = inputs[0];
    const second: I32Value = inputs[1];

    // @ts-expect-error a two-seed loop has no third input.
    inputs[2];
    body.loopContinue([first, second]);
  });

  region.loop([wide], (body, [input]) => {
    const carried: I64Value = input;

    body.loopContinue([carried]);
  });

  region.loop([firstSeed.ne(0)], (body, [input]) => {
    const carried: BitValue = input;

    body.loopContinue([carried]);
  });
}

export function regionLogicalWidthContract(
  region: RegionBuilder,
  address: I32Value,
  byte: Integer<8>,
  word: Integer<16>,
  byteVariable: VariableRef<8>,
  effect: ResourceEffect
): void {
  const inferredByte: VariableRef<8> = region.variable(byte);
  const readByte: Integer<8> = region.read(byteVariable);
  const operand: ResourceAccess<8> = {
    effect,
    address: { base: address, displacement: 0 },
    width: 8,
    valueWidth: 8
  };
  // @ts-expect-error a logical value cannot be wider than its storage transfer.
  const invalidOperand: ResourceAccess<8, 16> = {
    effect,
    address: { base: address, displacement: 0 },
    width: 8,
    valueWidth: 16
  };
  const resourceByte: Integer<8> = region.readResource(operand);
  const joinedByte: Integer<8> = region.ifValue(
    address.ne(0),
    () => byte,
    () => resourceByte
  );

  region.write(byteVariable, byte);
  region.writeResource(operand, byte);
  region.loop([byte], (body, [input]) => {
    const carried: Integer<8> = input;

    body.loopContinue([carried]);
  });

  // @ts-expect-error an 8-bit variable rejects a 16-bit value.
  region.write(byteVariable, word);
  // @ts-expect-error an 8-bit resource transfer rejects a 16-bit value.
  region.writeResource(operand, word);
  region.ifValue(
    address.ne(0),
    () => byte,
    // @ts-expect-error value-producing arms must return the same logical width.
    () => word
  );

  void [inferredByte, readByte, joinedByte, invalidOperand];
}
