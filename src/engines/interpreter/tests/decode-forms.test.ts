import { ok, strictEqual } from "node:assert";
import { test } from "node:test";

import {
  deriveModRmFormSelection,
  selectModRmForm
} from "#core/decoder/model/candidates.js";
import { X86_32_DECODE_MODEL } from "#core/decoder/model/index.js";
import type {
  DecodeCandidate,
  InstructionForm,
  ModRmModeForms,
  OpcodeNode
} from "#core/decoder/model/types.js";
import {
  exactModRmCases,
  memoryFormDispatch,
  modRmRegCases
} from "#engines/interpreter/decode/forms.js";

type ModRmCandidate = Extract<DecodeCandidate, { kind: "modRm" }>;

test("Interpreter ModRM lowering agrees with shared form selection", () => {
  const candidates = modRmCandidates(X86_32_DECODE_MODEL.opcodeRoot);
  let mode = 0;
  let reg = 0;
  let exact = 0;

  for (const candidate of candidates) {
    switch (candidate.formSelection.kind) {
      case "exact":
        exact += 1;
        break;
      case "fields":
        switch (candidate.formSelection.fields.kind) {
          case "mode":
            mode += 1;
            break;
          case "reg":
            reg += 1;
            break;
        }
        break;
    }
    for (let encoded = 0; encoded < 256; encoded += 1) {
      strictEqual(
        selectedForm(candidate, encoded),
        selectModRmForm(candidate.formSelection, encoded),
        `ModRM byte ${encoded.toString(16).padStart(2, "0")}`
      );
    }
  }

  strictEqual(mode, 148, "mode-only ModRM selection count changed");
  strictEqual(reg, 34, "reg-field ModRM selection count changed");
  strictEqual(exact, 0, "current decode model unexpectedly needs exact selection");
});

test("Interpreter ModRM lowering retains exact selection", () => {
  const form = X86_32_DECODE_MODEL.forms.find(
    (candidate) => candidate.operands.some(
      (operand) =>
        operand.kind === "modrm.rm" && operand.form === "registerOrMemory"
    )
  );

  ok(form !== undefined, "decode model has no ModRM form");
  const byByte = Array<InstructionForm | undefined>(256);

  byByte[0x03] = form;
  byByte[0xc3] = form;
  const candidate: ModRmCandidate = {
    kind: "modRm",
    formSelection: deriveModRmFormSelection(byByte)
  };

  strictEqual(candidate.formSelection.kind, "exact");
  for (let encoded = 0; encoded < 256; encoded += 1) {
    strictEqual(selectedForm(candidate, encoded), byByte[encoded]);
  }
});

test("memory form ordinals address every switch group", () => {
  ok(
    memoryFormDispatch.ordinalByForm.size > memoryFormDispatch.groupSize,
    "test corpus does not cross a switch-group boundary"
  );
  for (const group of memoryFormDispatch.groups) {
    ok(group.length <= memoryFormDispatch.groupSize);
  }
  for (const [form, ordinal] of memoryFormDispatch.ordinalByForm) {
    const group = Math.floor(ordinal / memoryFormDispatch.groupSize);
    const slot = ordinal % memoryFormDispatch.groupSize;

    strictEqual(memoryFormDispatch.groups[group]?.[slot], form);
  }
});

function modRmCandidates(root: OpcodeNode): readonly ModRmCandidate[] {
  const found = new Set<ModRmCandidate>();

  function visit(node: OpcodeNode): void {
    if (node.leaf !== undefined) {
      for (const candidate of node.leaf.byPrefix) {
        if (candidate.kind === "modRm") {
          found.add(candidate);
        }
      }
    }
    for (const next of node.next) {
      if (next !== undefined) {
        visit(next);
      }
    }
  }

  visit(root);
  return [...found];
}

function selectedForm(
  candidate: ModRmCandidate,
  byte: number
): InstructionForm | undefined {
  switch (candidate.formSelection.kind) {
    case "exact": {
      const selected = exactModRmCases(candidate.formSelection.byByte).find(
        (candidateCase) => candidateCase.matches.includes(byte)
      );

      if (selected !== undefined) {
        strictEqual(
          selected.mode,
          byte >= 0xc0 ? "register" : "memory"
        );
      }
      return selected?.form;
    }
    case "fields":
      switch (candidate.formSelection.fields.kind) {
        case "mode":
          return modeForm(candidate.formSelection.fields.forms, byte);
        case "reg": {
          const regField = (byte >>> 3) & 0b111;
          const selected = modRmRegCases(
            candidate.formSelection.fields.byReg
          ).find(
            (candidateCase) => candidateCase.matches.includes(regField)
          );

          return selected === undefined
            ? undefined
            : modeForm(selected.forms, byte);
        }
      }
  }
}

function modeForm(
  forms: ModRmModeForms,
  byte: number
): InstructionForm | undefined {
  return byte >= 0xc0 ? forms.register : forms.memory;
}
