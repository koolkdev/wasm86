import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  deriveModRmFormSelection,
  selectModRmForm
} from "#core/decoder/model/candidates.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type {
  InstructionForm,
  ModRmFormSelection
} from "#core/decoder/model/types.js";

test("derives mode-only ModRM selection without changing byte lookup", () => {
  const [registerForm, memoryForm] = X86_32_DECODE_MODEL.forms;

  ok(registerForm !== undefined && memoryForm !== undefined);
  const table = Array.from(
    { length: 256 },
    (_, byte) => byte >= 0xc0 ? registerForm : memoryForm
  );
  const selection = deriveModRmFormSelection(table);

  ok(selection.kind === "fields");
  strictEqual(selection.fields.kind, "mode");
  assertLookupPreserved(table, selection);
});

test("derives reg-field ModRM selection without changing byte lookup", () => {
  const [registerForm, memoryForm, alternateForm] =
    X86_32_DECODE_MODEL.forms;

  ok(
    registerForm !== undefined &&
    memoryForm !== undefined &&
    alternateForm !== undefined
  );
  const table = Array.from(
    { length: 256 },
    (_, byte) => {
      switch ((byte >>> 3) & 0b111) {
        case 0:
          return byte >= 0xc0 ? registerForm : memoryForm;
        case 1:
          return alternateForm;
        default:
          return undefined;
      }
    }
  );
  const selection = deriveModRmFormSelection(table);

  ok(selection.kind === "fields");
  strictEqual(selection.fields.kind, "reg");
  assertLookupPreserved(table, selection);
});

test("retains exact ModRM selection when byte lookup cannot be factored", () => {
  const [memoryForm, registerForm] = X86_32_DECODE_MODEL.forms;

  ok(memoryForm !== undefined && registerForm !== undefined);
  const table = Array<InstructionForm | undefined>(256);

  table[0x03] = memoryForm;
  table[0xc3] = registerForm;
  const selection = deriveModRmFormSelection(table);

  strictEqual(selection.kind, "exact");
  assertLookupPreserved(table, selection);
});

function assertLookupPreserved(
  table: readonly (InstructionForm | undefined)[],
  selection: ModRmFormSelection
): void {
  for (let byte = 0; byte < 256; byte += 1) {
    strictEqual(selectModRmForm(selection, byte), table[byte]);
  }
}
