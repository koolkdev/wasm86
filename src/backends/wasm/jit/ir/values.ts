import { reg32, widthMask, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import type {
  ConditionCode,
  FlagProducerName,
  IrBinaryOperator,
  IrUnaryOperator,
  IrValueType
} from "#x86/ir/model/types.js";
import { FLAG_PRODUCERS } from "#x86/ir/model/flags.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#x86/ir/model/flag-effects.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { OperandRef, StorageRef, ValueRef } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import {
  extractJitRegisterAccessValue,
  fullRegisterValueForEntry,
  jitStorageRegisterAccess,
  readRegisterValueEntry,
  registerValueEntryHasFullValue,
  type JitRegisterAccess,
  type JitRegisterValueMap
} from "#backends/wasm/jit/ir/register-prefix-values.js";

export type JitConstValue = Readonly<{ kind: "const"; type: IrValueType; value: number }>;
export type JitRegValue = Readonly<{ kind: "reg"; reg: Reg32 }>;
export type JitProducedValueId = string;
export type JitProducedValue = Readonly<{ kind: "produced"; id: JitProducedValueId; type: IrValueType }>;

export type JitBinaryValue = Readonly<{
  kind: "value.binary";
  type: IrValueType;
  operator: IrBinaryOperator;
  a: JitValue;
  b: JitValue;
}>;

export type JitUnaryValue = Readonly<{
  kind: "value.unary";
  type: IrValueType;
  operator: IrUnaryOperator;
  value: JitValue;
}>;

export type JitSelectValue = Readonly<{
  kind: "value.select";
  type: IrValueType;
  condition: JitValue;
  whenTrue: JitValue;
  whenFalse: JitValue;
}>;

export type JitArchitecturalSlot =
  | Readonly<{ kind: "reg32"; reg: Reg32 }>
  | Readonly<{ kind: "aluFlags" }>;

export type JitInputValue = Readonly<{
  kind: "input";
  slot: JitArchitecturalSlot;
}>;

export type JitExtractBitsValue = Readonly<{
  kind: "extractBits";
  value: JitValue;
  bitOffset: number;
  width: OperandWidth;
}>;

export type JitInsertBitsValue = Readonly<{
  kind: "insertBits";
  base: JitValue;
  value: JitValue;
  bitOffset: number;
  width: OperandWidth;
}>;

export type JitExtractMaskedBitsValue = Readonly<{
  kind: "extractMaskedBits";
  value: JitValue;
  mask: number;
}>;

export type JitInsertMaskedBitsValue = Readonly<{
  kind: "insertMaskedBits";
  base: JitValue;
  value: JitValue;
  mask: number;
}>;

export type JitFlagProducerValue = Readonly<{
  kind: "flagProducer";
  producer: FlagProducerName;
  width?: OperandWidth;
  inputs: Readonly<Record<string, JitValue>>;
  mask: number;
}>;

export type JitFlagConditionValue = Readonly<{
  kind: "flagCondition";
  flags: JitValue;
  cc: ConditionCode;
}>;

export type JitValue =
  | JitConstValue
  | JitRegValue
  | JitProducedValue
  | JitUnaryValue
  | JitBinaryValue
  | JitSelectValue
  | JitInputValue
  | JitExtractBitsValue
  | JitInsertBitsValue
  | JitExtractMaskedBitsValue
  | JitInsertMaskedBitsValue
  | JitFlagProducerValue
  | JitFlagConditionValue;

export type JitLegacyRewritableValue =
  | JitConstValue
  | JitRegValue
  | Readonly<{
      kind: "value.binary";
      type: IrValueType;
      operator: IrBinaryOperator;
      a: JitLegacyRewritableValue;
      b: JitLegacyRewritableValue;
    }>
  | Readonly<{
      kind: "value.unary";
      type: IrValueType;
      operator: IrUnaryOperator;
      value: JitLegacyRewritableValue;
    }>
  | Readonly<{
      kind: "value.select";
      type: IrValueType;
      condition: JitLegacyRewritableValue;
      whenTrue: JitLegacyRewritableValue;
      whenFalse: JitLegacyRewritableValue;
    }>;

export function jitInputReg32Value(reg: Reg32): JitInputValue {
  return { kind: "input", slot: { kind: "reg32", reg } };
}

export function jitInputAluFlagsValue(): JitInputValue {
  return { kind: "input", slot: { kind: "aluFlags" } };
}

export function jitProducedValue(id: JitProducedValueId, type: IrValueType): JitProducedValue {
  return { kind: "produced", id, type };
}

export function jitFlagProducerValue(
  producer: FlagProducerName,
  inputs: Readonly<Record<string, JitValue>>,
  options: Readonly<{ width?: OperandWidth; mask?: number }> = {}
): JitValue {
  const normalizedWidth = normalizeOptionalWidth(options.width);
  const mask = normalizeFlagProducerMask(producer, options.mask ?? FLAG_PRODUCERS[producer].writtenMask);

  return simplifyJitValue({
    kind: "flagProducer",
    producer,
    ...(normalizedWidth === undefined ? {} : { width: normalizedWidth }),
    inputs,
    mask
  });
}

export function jitExtractBits(value: JitValue, bitOffset: number, width: OperandWidth): JitValue {
  return simplifyJitValue({ kind: "extractBits", value, bitOffset, width });
}

export function jitInsertBits(
  base: JitValue,
  value: JitValue,
  bitOffset: number,
  width: OperandWidth
): JitValue {
  return simplifyJitValue({ kind: "insertBits", base, value, bitOffset, width });
}

export function jitExtractMaskedBits(value: JitValue, mask: number): JitValue {
  return simplifyJitValue({ kind: "extractMaskedBits", value, mask });
}

export function jitInsertMaskedBits(base: JitValue, value: JitValue, mask: number): JitValue {
  return simplifyJitValue({ kind: "insertMaskedBits", base, value, mask });
}

export function jitFlagConditionValue(flags: JitValue, cc: ConditionCode): JitValue {
  return simplifyJitValue({ kind: "flagCondition", flags, cc });
}

export function jitValueForStorage(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  registerValues: JitRegisterValueMap = new Map(),
  accessWidth: OperandWidth = 32,
  signed = false
): JitValue | undefined {
  const value = jitValueForStorageUnsigned(storage, operands, registerValues, accessWidth);

  return value === undefined || !signed || accessWidth >= 32
    ? value
    : signExtendJitValue(value, accessWidth as 8 | 16);
}

function jitValueForStorageUnsigned(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  registerValues: JitRegisterValueMap,
  accessWidth: OperandWidth
): JitValue | undefined {
  switch (storage.kind) {
    case "reg":
      return jitValueForRegisterAccess({ reg: storage.reg, width: accessWidth, bitOffset: 0 }, registerValues);
    case "operand": {
      const binding = operands[storage.index]!;

      return jitValueForOperandBinding(binding, registerValues, accessWidth);
    }
    case "mem":
      return undefined;
  }
}

export function jitValueForValue(
  value: ValueRef,
  localValues: ReadonlyMap<number, JitValue>
): JitValue | undefined {
  switch (value.kind) {
    case "var":
      return localValues.get(value.id);
    case "const":
      return { kind: "const", type: value.type, value: i32(value.value) };
    case "nextEip":
      return undefined;
  }
}

export function jitValueForEffectiveAddress(
  operand: OperandRef,
  operands: readonly JitOperandBinding[],
  registerValues: JitRegisterValueMap
): JitValue | undefined {
  const binding = operands[operand.index]!;

  if (binding.kind !== "static.mem") {
    return undefined;
  }

  const terms: JitValue[] = [];

  if (binding.ea.base !== undefined) {
    terms.push(jitValueForReg(binding.ea.base, registerValues));
  }

  if (binding.ea.index !== undefined) {
    if (binding.ea.scale !== 1) {
      return undefined;
    }

    terms.push(jitValueForReg(binding.ea.index, registerValues));
  }

  if (binding.ea.disp !== 0 || terms.length === 0) {
    terms.push({ kind: "const", type: "i32", value: i32(binding.ea.disp) });
  }

  return terms.reduce((a, b) => simplifyJitValue({ kind: "value.binary", type: "i32", operator: "add", a, b }));
}

export function jitRegisterValuesReadByEffectiveAddress(
  operand: OperandRef,
  operands: readonly JitOperandBinding[],
  registerValues: JitRegisterValueMap
): readonly Reg32[] {
  const binding = operands[operand.index]!;

  if (binding.kind !== "static.mem") {
    return [];
  }

  const regs = new Set<Reg32>();

  if (binding.ea.base !== undefined && registerValueEntryHasFullValue(registerValues.get(binding.ea.base))) {
    regs.add(binding.ea.base);
  }

  if (binding.ea.index !== undefined && registerValueEntryHasFullValue(registerValues.get(binding.ea.index))) {
    regs.add(binding.ea.index);
  }

  return [...regs];
}

export function jitStorageReg(storage: StorageRef, operands: readonly JitOperandBinding[]): Reg32 | undefined {
  return jitStorageRegisterAccess(storage, operands)?.reg;
}

export function jitStorageHasRegisterValue(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  registerValues: JitRegisterValueMap,
  accessWidth: OperandWidth = 32
): boolean {
  const access = jitStorageRegisterAccess(storage, operands, accessWidth);

  return access !== undefined &&
    readRegisterValueEntry(registerValues.get(access.reg), access.width, access.bitOffset) !== undefined;
}

export function jitValueReadsReg(value: JitValue, reg: Reg32): boolean {
  return jitValueChildren(value).some((child) => jitValueReadsReg(child, reg));
}

export function jitValueReadRegs(value: JitValue): readonly Reg32[] {
  return reg32.filter((reg) => jitValueReadsReg(value, reg));
}

export function jitValueMaterializationRegs(value: JitValue): readonly Reg32[] {
  const slots = jitValueMaterializationSlots(value);

  return reg32.filter((reg) =>
    slots.some((slot) => slot.kind === "reg32" && slot.reg === reg)
  );
}

export function jitValueMaterializationSlots(value: JitValue): readonly JitArchitecturalSlot[] {
  const slots = new Map<string, JitArchitecturalSlot>();

  collectMaterializationSlots(simplifyJitValue(value), slots);
  return [...slots.values()];
}

export function jitValueUsesSymbolicReg(value: JitValue, reg: Reg32): boolean {
  switch (value.kind) {
    case "reg":
      return value.reg === reg;
    case "input":
      return value.slot.kind === "reg32" && value.slot.reg === reg;
    default:
      return jitValueChildren(value).some((child) => jitValueUsesSymbolicReg(child, reg));
  }
}

export function jitValuesEqual(a: JitValue, b: JitValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }

  switch (a.kind) {
    case "value.binary": {
      const binary = b as JitBinaryValue;

      return a.type === binary.type &&
        a.operator === binary.operator &&
        jitValuesEqual(a.a, binary.a) &&
        jitValuesEqual(a.b, binary.b);
    }
    case "value.unary": {
      const unary = b as JitUnaryValue;

      return a.type === unary.type &&
        a.operator === unary.operator &&
        jitValuesEqual(a.value, unary.value);
    }
    case "value.select": {
      const select = b as JitSelectValue;

      return a.type === select.type &&
        jitValuesEqual(a.condition, select.condition) &&
        jitValuesEqual(a.whenTrue, select.whenTrue) &&
        jitValuesEqual(a.whenFalse, select.whenFalse);
    }
    case "const": {
      const constant = b as JitConstValue;

      return a.type === constant.type && a.value === constant.value;
    }
    case "produced": {
      const produced = b as JitProducedValue;

      return a.id === produced.id && a.type === produced.type;
    }
    case "reg":
      return a.reg === (b as JitRegValue).reg;
    case "input":
      return jitArchitecturalSlotsEqual(a.slot, (b as JitInputValue).slot);
    case "extractBits": {
      const extract = b as JitExtractBitsValue;

      return a.bitOffset === extract.bitOffset &&
        a.width === extract.width &&
        jitValuesEqual(a.value, extract.value);
    }
    case "insertBits": {
      const insert = b as JitInsertBitsValue;

      return a.bitOffset === insert.bitOffset &&
        a.width === insert.width &&
        jitValuesEqual(a.base, insert.base) &&
        jitValuesEqual(a.value, insert.value);
    }
    case "extractMaskedBits": {
      const extract = b as JitExtractMaskedBitsValue;

      return normalizeU32Mask(a.mask, "extractMaskedBits mask") ===
        normalizeU32Mask(extract.mask, "extractMaskedBits mask") &&
        jitValuesEqual(a.value, extract.value);
    }
    case "insertMaskedBits": {
      const insert = b as JitInsertMaskedBitsValue;

      return normalizeU32Mask(a.mask, "insertMaskedBits mask") ===
        normalizeU32Mask(insert.mask, "insertMaskedBits mask") &&
        jitValuesEqual(a.base, insert.base) &&
        jitValuesEqual(a.value, insert.value);
    }
    case "flagProducer": {
      const producer = b as JitFlagProducerValue;

      return a.producer === producer.producer &&
        flagProducerWidth(a) === flagProducerWidth(producer) &&
        normalizeFlagProducerMask(a.producer, a.mask) === normalizeFlagProducerMask(producer.producer, producer.mask) &&
        jitValueInputRecordsEqual(a.inputs, producer.inputs);
    }
    case "flagCondition": {
      const condition = b as JitFlagConditionValue;

      return a.cc === condition.cc && jitValuesEqual(a.flags, condition.flags);
    }
  }
}

export function simplifyJitValue(value: JitValue): JitValue {
  switch (value.kind) {
    case "const": {
      const normalized = i32(value.value);

      return normalized === value.value ? value : { ...value, value: normalized };
    }
    case "reg":
    case "produced":
    case "input":
      return value;
    case "value.binary":
      return simplifyJitBinaryValue(value);
    case "value.unary":
      return simplifyJitUnaryValue(value);
    case "value.select":
      return simplifyJitSelectValue(value);
    case "extractBits":
      return simplifyJitExtractBitsValue(value);
    case "insertBits":
      return simplifyJitInsertBitsValue(value);
    case "extractMaskedBits":
      return simplifyJitExtractMaskedBitsValue(value);
    case "insertMaskedBits":
      return simplifyJitInsertMaskedBitsValue(value);
    case "flagProducer":
      return simplifyJitFlagProducerValue(value);
    case "flagCondition": {
      const flags = simplifyJitValue(value.flags);

      return flags === value.flags ? value : { ...value, flags };
    }
  }
}

export function jitValueCost(value: JitValue): number {
  const simplified = simplifyJitValue(value);

  if (simplified !== value) {
    return jitValueCost(simplified);
  }

  switch (value.kind) {
    case "value.binary":
      return 1 + jitValueCost(value.a) + jitValueCost(value.b);
    case "value.unary":
      return 1 + jitValueCost(value.value);
    case "value.select":
      return 1 + jitValueCost(value.condition) + jitValueCost(value.whenTrue) + jitValueCost(value.whenFalse);
    case "extractBits":
    case "extractMaskedBits":
    case "flagCondition":
      return 1 + jitValueCost(value.kind === "flagCondition" ? value.flags : value.value);
    case "insertBits":
    case "insertMaskedBits":
      return 1 + jitValueCost(value.base) + jitValueCost(value.value);
    case "flagProducer":
      return 1 + flagProducerInputValues(value).reduce((cost, input) => cost + jitValueCost(input), 0);
    case "const":
    case "reg":
    case "produced":
    case "input":
      return 1;
  }
}

export function jitValueKey(value: JitValue): string {
  const simplified = simplifyJitValue(value);

  if (simplified !== value) {
    return jitValueKey(simplified);
  }

  switch (value.kind) {
    case "const":
      return `const:${value.type}:${i32(value.value)}`;
    case "reg":
      return `reg:${value.reg}`;
    case "produced":
      return `produced:${value.type}:${value.id}`;
    case "input":
      return `input:${jitArchitecturalSlotKey(value.slot)}`;
    case "value.binary":
      return `binary:${value.type}:${value.operator}:${jitValueKey(value.a)}:${jitValueKey(value.b)}`;
    case "value.unary":
      return `unary:${value.type}:${value.operator}:${jitValueKey(value.value)}`;
    case "value.select":
      return `select:${value.type}:${jitValueKey(value.condition)}:${jitValueKey(value.whenTrue)}:${jitValueKey(value.whenFalse)}`;
    case "extractBits":
      return `extractBits:${value.bitOffset}:${value.width}:${jitValueKey(value.value)}`;
    case "insertBits":
      return `insertBits:${value.bitOffset}:${value.width}:${jitValueKey(value.base)}:${jitValueKey(value.value)}`;
    case "extractMaskedBits":
      return `extractMaskedBits:${normalizeU32Mask(value.mask, "extractMaskedBits mask")}:${jitValueKey(value.value)}`;
    case "insertMaskedBits":
      return `insertMaskedBits:${normalizeU32Mask(value.mask, "insertMaskedBits mask")}:${jitValueKey(value.base)}:${jitValueKey(value.value)}`;
    case "flagProducer":
      return `flagProducer:${value.producer}:${flagProducerWidth(value)}:${normalizeFlagProducerMask(value.producer, value.mask)}:${jitValueInputRecordKey(value.inputs)}`;
    case "flagCondition":
      return `flagCondition:${value.cc}:${jitValueKey(value.flags)}`;
  }
}

export function jitValueDependencies(value: JitValue): readonly JitValue[] {
  return jitValueChildren(value);
}

export function walkJitValueDependencies(value: JitValue, visit: (dependency: JitValue) => void): void {
  for (const child of jitValueChildren(value)) {
    visit(child);
    walkJitValueDependencies(child, visit);
  }
}

export function jitValueIsSymbolicReg(value: JitValue, reg?: Reg32): value is JitRegValue {
  return value.kind === "reg" && (reg === undefined || value.reg === reg);
}

export function jitValueIsLegacyRewritable(value: JitValue): value is JitLegacyRewritableValue {
  switch (value.kind) {
    case "const":
    case "reg":
      return true;
    case "value.binary":
      return jitValueIsLegacyRewritable(value.a) && jitValueIsLegacyRewritable(value.b);
    case "value.unary":
      return jitValueIsLegacyRewritable(value.value);
    case "value.select":
      return jitValueIsLegacyRewritable(value.condition) &&
        jitValueIsLegacyRewritable(value.whenTrue) &&
        jitValueIsLegacyRewritable(value.whenFalse);
    case "input":
    case "produced":
    case "extractBits":
    case "insertBits":
    case "extractMaskedBits":
    case "insertMaskedBits":
    case "flagProducer":
    case "flagCondition":
      return false;
  }
}

function jitValueForReg(
  reg: Reg32,
  registerValues: JitRegisterValueMap
): JitValue {
  return fullRegisterValueForEntry(registerValues.get(reg)) ?? { kind: "reg", reg };
}

function jitValueForOperandBinding(
  binding: JitOperandBinding,
  registerValues: JitRegisterValueMap,
  accessWidth: OperandWidth
): JitValue | undefined {
  switch (binding.kind) {
    case "static.reg":
      return jitValueForRegisterAccess({
        reg: binding.alias.base,
        width: binding.alias.width,
        bitOffset: binding.alias.bitOffset
      }, registerValues);
    case "static.imm32":
      return extractJitRegisterAccessValue({ kind: "const", type: "i32", value: i32(binding.value) }, accessWidth, 0);
    case "static.relTarget":
      return extractJitRegisterAccessValue({ kind: "const", type: "i32", value: i32(binding.target) }, accessWidth, 0);
    case "static.mem":
      return undefined;
  }
}

function signExtendJitValue(value: JitValue, width: 8 | 16): JitValue {
  const simplified = simplifyJitValue(value);

  if (simplified.kind === "const") {
    return { kind: "const", type: simplified.type, value: signExtendConst(simplified.value, width) };
  }

  return simplifyJitValue({
    kind: "value.unary",
    type: "i32",
    operator: width === 8 ? "extend8_s" : "extend16_s",
    value: simplified
  });
}

function signExtendConst(value: number, width: 8 | 16): number {
  const masked = value & widthMask(width);
  const shift = 32 - width;

  return i32((masked << shift) >> shift);
}

function jitValueForRegisterAccess(
  access: JitRegisterAccess,
  registerValues: JitRegisterValueMap
): JitValue | undefined {
  const value = readRegisterValueEntry(registerValues.get(access.reg), access.width, access.bitOffset);

  if (value !== undefined) {
    return value;
  }

  return access.width === 32 && access.bitOffset === 0
    ? { kind: "reg", reg: access.reg }
    : undefined;
}

function simplifyJitBinaryValue(value: JitBinaryValue): JitValue {
  const a = simplifyJitValue(value.a);
  const b = simplifyJitValue(value.b);

  if (b.kind === "const") {
    switch (value.operator) {
      case "add":
      case "or":
      case "xor":
      case "shr_u":
        if (b.value === 0) {
          return a;
        }
        break;
      case "sub":
        if (b.value === 0) {
          return a;
        }
        break;
      case "and":
        if ((b.value >>> 0) === 0xffff_ffff) {
          return a;
        }
        if (b.value === 0) {
          return { kind: "const", type: value.type, value: 0 };
        }
        break;
    }
  }

  if (a.kind === "const") {
    switch (value.operator) {
      case "add":
      case "or":
      case "xor":
        if (a.value === 0) {
          return b;
        }
        break;
      case "and":
        if ((a.value >>> 0) === 0xffff_ffff) {
          return b;
        }
        if (a.value === 0) {
          return { kind: "const", type: value.type, value: 0 };
        }
        break;
      case "sub":
      case "shr_u":
        break;
    }
  }

  return a === value.a && b === value.b ? value : { ...value, a, b };
}

function simplifyJitUnaryValue(value: JitUnaryValue): JitValue {
  const inner = simplifyJitValue(value.value);

  if (inner.kind === "const") {
    return { kind: "const", type: value.type, value: foldUnaryConst(value.operator, inner.value) };
  }

  return inner === value.value ? value : { ...value, value: inner };
}

function simplifyJitSelectValue(value: JitSelectValue): JitValue {
  const condition = simplifyJitValue(value.condition);
  const whenTrue = simplifyJitValue(value.whenTrue);
  const whenFalse = simplifyJitValue(value.whenFalse);

  if (condition.kind === "const") {
    return condition.value !== 0 ? whenTrue : whenFalse;
  }

  if (jitValuesEqual(whenTrue, whenFalse)) {
    return whenTrue;
  }

  return condition === value.condition && whenTrue === value.whenTrue && whenFalse === value.whenFalse
    ? value
    : { ...value, condition, whenTrue, whenFalse };
}

function simplifyJitExtractBitsValue(value: JitExtractBitsValue): JitValue {
  assertBitRange(value.bitOffset, value.width, "extractBits");
  const source = simplifyJitValue(value.value);

  if (value.bitOffset === 0 && value.width === 32) {
    return source;
  }

  if (source.kind === "const") {
    return { kind: "const", type: source.type, value: extractConstBits(source.value, value.bitOffset, value.width) };
  }

  if (source.kind === "extractBits" && value.bitOffset + value.width <= source.width) {
    return simplifyJitValue({
      kind: "extractBits",
      value: source.value,
      bitOffset: source.bitOffset + value.bitOffset,
      width: value.width
    });
  }

  if (source.kind === "insertBits") {
    const relationship = bitRangeRelationship(
      value.bitOffset,
      value.width,
      source.bitOffset,
      source.width
    );

    if (relationship === "same") {
      return simplifyJitValue({ kind: "extractBits", value: source.value, bitOffset: 0, width: value.width });
    }

    if (relationship === "disjoint") {
      return simplifyJitValue({ ...value, value: source.base });
    }
  }

  return source === value.value ? value : { ...value, value: source };
}

function simplifyJitInsertBitsValue(value: JitInsertBitsValue): JitValue {
  assertBitRange(value.bitOffset, value.width, "insertBits");
  const base = simplifyJitValue(value.base);
  const inserted = simplifyJitValue(value.value);

  if (value.bitOffset === 0 && value.width === 32) {
    return inserted;
  }

  if (base.kind === "const" && inserted.kind === "const") {
    return {
      kind: "const",
      type: base.type,
      value: insertConstBits(base.value, inserted.value, value.bitOffset, value.width)
    };
  }

  if (inserted.kind === "extractBits" &&
    inserted.bitOffset === value.bitOffset &&
    inserted.width === value.width &&
    jitValuesEqual(inserted.value, base)) {
    return base;
  }

  if (base.kind === "insertBits" && base.bitOffset === value.bitOffset && base.width === value.width) {
    return simplifyJitValue({ ...value, base: base.base, value: inserted });
  }

  return base === value.base && inserted === value.value ? value : { ...value, base, value: inserted };
}

function simplifyJitExtractMaskedBitsValue(value: JitExtractMaskedBitsValue): JitValue {
  const mask = normalizeU32Mask(value.mask, "extractMaskedBits mask");
  const source = simplifyJitValue(value.value);

  if (mask === 0) {
    return { kind: "const", type: "i32", value: 0 };
  }

  if (mask === 0xffff_ffff) {
    return source;
  }

  if (source.kind === "const") {
    return { kind: "const", type: source.type, value: i32((source.value >>> 0) & mask) };
  }

  if (source.kind === "extractMaskedBits") {
    return simplifyJitValue({ ...value, value: source.value, mask: mask & normalizeU32Mask(source.mask, "extractMaskedBits mask") });
  }

  if (source.kind === "insertMaskedBits") {
    const insertedMask = normalizeU32Mask(source.mask, "insertMaskedBits mask");

    if ((mask & ~insertedMask) === 0) {
      return simplifyJitValue({ ...value, value: source.value, mask });
    }

    if ((mask & insertedMask) === 0) {
      return simplifyJitValue({ ...value, value: source.base, mask });
    }
  }

  return source === value.value && mask === value.mask ? value : { ...value, value: source, mask };
}

function simplifyJitInsertMaskedBitsValue(value: JitInsertMaskedBitsValue): JitValue {
  const mask = normalizeU32Mask(value.mask, "insertMaskedBits mask");
  const base = simplifyJitValue(value.base);
  const inserted = simplifyJitValue(value.value);

  if (mask === 0) {
    return base;
  }

  if (mask === 0xffff_ffff) {
    return inserted;
  }

  if (base.kind === "const" && inserted.kind === "const") {
    return {
      kind: "const",
      type: base.type,
      value: i32(((base.value >>> 0) & (~mask >>> 0)) | ((inserted.value >>> 0) & mask))
    };
  }

  if (inserted.kind === "extractMaskedBits" &&
    normalizeU32Mask(inserted.mask, "extractMaskedBits mask") === mask &&
    jitValuesEqual(inserted.value, base)) {
    return base;
  }

  if (base.kind === "insertMaskedBits" && normalizeU32Mask(base.mask, "insertMaskedBits mask") === mask) {
    return simplifyJitValue({ ...value, base: base.base, value: inserted, mask });
  }

  return base === value.base && inserted === value.value && mask === value.mask
    ? value
    : { ...value, base, value: inserted, mask };
}

function simplifyJitFlagProducerValue(value: JitFlagProducerValue): JitValue {
  const width = normalizeOptionalWidth(value.width);
  const mask = normalizeFlagProducerMask(value.producer, value.mask);

  if (mask === 0) {
    return { kind: "const", type: "i32", value: 0 };
  }

  const inputs = simplifyJitValueInputRecord(value.inputs);

  return inputs === value.inputs && mask === value.mask && width === value.width
    ? value
    : {
        kind: "flagProducer",
        producer: value.producer,
        ...(width === undefined ? {} : { width }),
        inputs,
        mask
      };
}

function foldUnaryConst(operator: IrUnaryOperator, value: number): number {
  switch (operator) {
    case "extend8_s":
      return signExtendConst(value, 8);
    case "extend16_s":
      return signExtendConst(value, 16);
  }
}

function extractConstBits(value: number, bitOffset: number, width: OperandWidth): number {
  return i32(((value >>> 0) >>> bitOffset) & (widthMask(width) >>> 0));
}

function insertConstBits(base: number, value: number, bitOffset: number, width: OperandWidth): number {
  const mask = bitRangeMask(bitOffset, width);
  const replacement = (((value >>> 0) & (widthMask(width) >>> 0)) << bitOffset) >>> 0;

  return i32(((base >>> 0) & (~mask >>> 0)) | replacement);
}

function bitRangeMask(bitOffset: number, width: OperandWidth): number {
  return width === 32 ? 0xffff_ffff : ((widthMask(width) << bitOffset) >>> 0);
}

function bitRangeRelationship(
  leftOffset: number,
  leftWidth: OperandWidth,
  rightOffset: number,
  rightWidth: OperandWidth
): "same" | "disjoint" | "overlap" {
  const leftEnd = leftOffset + leftWidth;
  const rightEnd = rightOffset + rightWidth;

  if (leftOffset === rightOffset && leftWidth === rightWidth) {
    return "same";
  }

  return leftEnd <= rightOffset || rightEnd <= leftOffset ? "disjoint" : "overlap";
}

function assertBitRange(bitOffset: number, width: OperandWidth, context: string): void {
  if (
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    !isOperandWidth(width) ||
    bitOffset + width > 32
  ) {
    throw new Error(`${context} range must fit in 32 bits`);
  }
}

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}

function normalizeU32Mask(mask: number, context: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff_ffff) {
    throw new Error(`${context} must be a 32-bit unsigned mask`);
  }

  return mask >>> 0;
}

function normalizeFlagProducerMask(producer: FlagProducerName, mask: number): number {
  assertIrAluFlagMask(mask, "flagProducer mask");
  const writtenMask = FLAG_PRODUCERS[producer].writtenMask;

  if ((mask & ~writtenMask) !== 0) {
    throw new Error(`flagProducer mask includes bits not written by ${producer}`);
  }

  return mask & IR_ALU_FLAG_MASK;
}

function normalizeOptionalWidth(width: OperandWidth | undefined): OperandWidth | undefined {
  if (width === undefined || width === 32) {
    return undefined;
  }

  if (!isOperandWidth(width)) {
    throw new Error(`JIT value width is not supported: ${width}`);
  }

  return width;
}

function flagProducerWidth(value: Pick<JitFlagProducerValue, "width">): OperandWidth {
  return value.width ?? 32;
}

function jitValueChildren(value: JitValue): readonly JitValue[] {
  switch (value.kind) {
    case "value.binary":
      return [value.a, value.b];
    case "value.unary":
      return [value.value];
    case "value.select":
      return [value.condition, value.whenTrue, value.whenFalse];
    case "extractBits":
    case "extractMaskedBits":
      return [value.value];
    case "insertBits":
    case "insertMaskedBits":
      return [value.base, value.value];
    case "flagProducer":
      return flagProducerInputValues(value);
    case "flagCondition":
      return [value.flags];
    case "const":
    case "reg":
    case "produced":
    case "input":
      return [];
  }
}

function flagProducerInputValues(value: JitFlagProducerValue): readonly JitValue[] {
  return jitValueInputRecordKeys(value.inputs).map((key) => requiredJitValueInput(value.inputs, key));
}

function simplifyJitValueInputRecord(inputs: Readonly<Record<string, JitValue>>): Readonly<Record<string, JitValue>> {
  let changed = false;
  const simplified: Record<string, JitValue> = {};

  for (const [key, value] of Object.entries(inputs)) {
    const simplifiedValue = simplifyJitValue(value);

    simplified[key] = simplifiedValue;
    changed ||= simplifiedValue !== value;
  }

  return changed ? simplified : inputs;
}

function jitValueInputRecordsEqual(
  left: Readonly<Record<string, JitValue>>,
  right: Readonly<Record<string, JitValue>>
): boolean {
  const leftKeys = jitValueInputRecordKeys(left);
  const rightKeys = jitValueInputRecordKeys(right);

  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && jitValuesEqual(requiredJitValueInput(left, key), requiredJitValueInput(right, key))
    );
}

function jitValueInputRecordKey(inputs: Readonly<Record<string, JitValue>>): string {
  return jitValueInputRecordKeys(inputs)
    .map((key) => `${key}=${jitValueKey(requiredJitValueInput(inputs, key))}`)
    .join(",");
}

function jitValueInputRecordKeys(inputs: Readonly<Record<string, JitValue>>): readonly string[] {
  return Object.keys(inputs).sort();
}

function requiredJitValueInput(inputs: Readonly<Record<string, JitValue>>, key: string): JitValue {
  const input = inputs[key];

  if (input === undefined) {
    throw new Error(`missing JIT value input '${key}'`);
  }

  return input;
}

function collectMaterializationSlots(value: JitValue, slots: Map<string, JitArchitecturalSlot>): void {
  switch (value.kind) {
    case "reg":
      slots.set(jitArchitecturalSlotKey({ kind: "reg32", reg: value.reg }), { kind: "reg32", reg: value.reg });
      return;
    case "input":
      slots.set(jitArchitecturalSlotKey(value.slot), value.slot);
      return;
    case "produced":
      return;
    default:
      for (const child of jitValueChildren(value)) {
        collectMaterializationSlots(child, slots);
      }
  }
}

function jitArchitecturalSlotsEqual(left: JitArchitecturalSlot, right: JitArchitecturalSlot): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  return left.kind === "aluFlags" || right.kind === "aluFlags" || left.reg === right.reg;
}

function jitArchitecturalSlotKey(slot: JitArchitecturalSlot): string {
  switch (slot.kind) {
    case "reg32":
      return `reg32:${slot.reg}`;
    case "aluFlags":
      return "aluFlags";
  }
}
