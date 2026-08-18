import type { Integer, BitValue, I32Value, I64Value } from "#compiler/function/values.js";
import type { SemanticOps, SemanticsBuilder, SemanticVar } from "../builder.js";
import type { OperandRef } from "../refs.js";

export function semanticStorageTypeContract(
  s: SemanticOps,
  operand: OperandRef,
  variable: SemanticVar,
  byte: Integer<8>,
  word: Integer<16>,
  dword: Integer<32>,
  addressOffset: I32Value
): void {
  const al: Integer<8> = s.read(s.reg("al"));
  const ax: Integer<16> = s.read(s.reg("ax"));
  const eax: Integer<32> = s.read(s.reg("eax"));
  const local: Integer<32> = s.read(variable);
  const source: Integer<16> = s.read(operand, 16);
  const registerUpdate = s.update(s.reg("ax"));
  const operandUpdate = s.update(operand, 16, {
    addressOffset
  });
  const registerUpdateValue: Integer<16> = s.read(registerUpdate);
  const operandUpdateValue: Integer<16> = s.read(operandUpdate);

  s.write(s.reg("al"), byte);
  s.write(s.reg("ax"), word);
  s.write(s.reg("eax"), dword);
  s.write(variable, dword);
  s.write(operand, dword, { memoryWidth: 16 });
  s.write(registerUpdate, word);
  s.write(operandUpdate, word);

  // @ts-expect-error an operand read must select its semantic width.
  s.read(operand);
  // @ts-expect-error a fixed register already owns its width.
  s.read(s.reg("al"), 8);
  // @ts-expect-error a register write must match the register width.
  s.write(s.reg("al"), word);
  // @ts-expect-error a semantic variable is a 32-bit storage location.
  s.write(variable, byte);
  // @ts-expect-error a memory write cannot widen its value.
  s.write(operand, byte, { memoryWidth: 16 });
  // @ts-expect-error an update retains its selected semantic width.
  s.write(registerUpdate, dword);

  void [al, ax, eax, local, source, registerUpdateValue, operandUpdateValue];
}

export function semanticConditionTypeContract(
  s: SemanticsBuilder,
  bit: BitValue,
  byte: Integer<8>,
  word: Integer<16>,
  wide: I64Value
): void {
  s.if(bit, () => {});
  s.ifElse(
    bit,
    () => {},
    () => {}
  );
  s.loop((body) => {
    body.if(bit, () => {});
    return bit;
  });

  // @ts-expect-error semantic conditions are one-bit values.
  s.if(byte, () => {});
  // @ts-expect-error semantic conditions are one-bit values.
  s.if(word, () => {});
  // @ts-expect-error loop completion conditions are one-bit values.
  s.loop(() => word);
  // @ts-expect-error semantic conditions are one-bit values.
  s.if(wide, () => {});
  // @ts-expect-error loop completion conditions are one-bit values.
  s.loop(() => wide);
}
