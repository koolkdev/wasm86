import { Control } from "#compiler/function/control.js";
import type { Region } from "#compiler/function/region.js";
import type { Float, Integer } from "#compiler/function/values.js";

const body: Region = { nodes: [] };

export function controlTypeContract(
  bit: Integer<1>,
  byte: Integer<8>,
  dword: Integer<32>,
  qword: Integer<64>,
  single: Float<32>
): void {
  const ordinaryIf = Control.if({ condition: bit, thenBody: body });
  const valueIf = Control.if({
    condition: bit,
    output: single,
    thenBody: body,
    elseBody: body
  });
  const switchControl = Control.switch({
    selector: dword,
    cases: [{ matches: [0], body }],
    defaultBody: body
  });

  // @ts-expect-error if conditions are one-bit integer values.
  Control.if({ condition: byte, thenBody: body });
  // @ts-expect-error a value-producing if requires an else body.
  Control.if({ condition: bit, output: single, thenBody: body });
  // @ts-expect-error switch selectors are integer values.
  Control.switch({ selector: single, cases: [], defaultBody: body });
  // @ts-expect-error switch selectors are at most 32 bits wide.
  Control.switch({ selector: qword, cases: [], defaultBody: body });

  void [ordinaryIf, valueIf, switchControl];
}
