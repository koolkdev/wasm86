import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createCpuState, getFlag } from "#x86/state/cpu-state.js";
import { executeDirectInstruction } from "#backends/direct/execute.js";
import type { IsaDecodedInstruction } from "#x86/decoder/types.js";
import type { SemanticTemplate } from "#ir/model/types.js";
import { decodeBytes, ok, startAddress } from "./helpers.js";

test("add_wrap_sets_cf_zf_af_pf", () => {
  const state = createCpuState({ eax: 0xffff_ffff, eip: startAddress });

  execute(state, [0x81, 0xc0, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), true);
  strictEqual(getFlag(state, "PF"), true);
});

test("add_byte_wrap_sets_width_flags_and_preserves_high_register_bits", () => {
  const state = createCpuState({ eax: 0x1234_56ff, ebx: 1, eip: startAddress });

  execute(state, [0x00, 0xd8]);

  strictEqual(state.eax, 0x1234_5600);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("add_word_wrap_sets_width_flags_and_preserves_high_register_bits", () => {
  const state = createCpuState({ eax: 0x1234_ffff, ebx: 1, eip: startAddress });

  execute(state, [0x66, 0x01, 0xd8]);

  strictEqual(state.eax, 0x1234_0000);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
});

test("add_signed_overflow_sets_of", () => {
  const state = createCpuState({ eax: 0x7fff_ffff, eip: startAddress });

  execute(state, [0x81, 0xc0, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0x8000_0000);
  strictEqual(getFlag(state, "OF"), true);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "ZF"), false);
});

test("sub_borrow_sets_cf", () => {
  const state = createCpuState({ eax: 0, eip: startAddress });

  execute(state, [0x81, 0xe8, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0xffff_ffff);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), true);
});

test("sub_signed_overflow_sets_of", () => {
  const state = createCpuState({ eax: 0x8000_0000, eip: startAddress });

  execute(state, [0x81, 0xe8, 0x01, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 0x7fff_ffff);
  strictEqual(getFlag(state, "OF"), true);
  strictEqual(getFlag(state, "SF"), false);
});

test("add_83_sign_extends", () => {
  const state = createCpuState({ eax: 2, eip: startAddress });

  execute(state, [0x83, 0xc0, 0xff]);

  strictEqual(state.eax, 1);
});

test("xor_clears_register_and_sets_zf", () => {
  const state = createCpuState({ eax: 0x1234, eip: startAddress });

  execute(state, [0x31, 0xc0]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), false);
});

test("inc_updates_status_flags_without_changing_cf", () => {
  const state = createCpuState({ eax: 0xffff_ffff, eip: startAddress, CF: 1 });

  execute(state, [0x40]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), true);
  strictEqual(getFlag(state, "PF"), true);
});

test("inc_byte_updates_width_flags_without_changing_cf", () => {
  const state = createCpuState({ eax: 0x1234_56ff, eip: startAddress, CF: 1 });

  execute(state, [0xfe, 0xc0]);

  strictEqual(state.eax, 0x1234_5600);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "SF"), false);
});

test("dec_updates_status_flags_without_changing_cf", () => {
  const state = createCpuState({ eax: 0, eip: startAddress, CF: 1 });

  execute(state, [0x48]);

  strictEqual(state.eax, 0xffff_ffff);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "OF"), false);
  strictEqual(getFlag(state, "AF"), true);
  strictEqual(getFlag(state, "PF"), true);
});

test("dec_word_updates_width_flags_without_changing_cf", () => {
  const state = createCpuState({ eax: 0x1234_0000, eip: startAddress, CF: 1 });

  execute(state, [0x66, 0x48]);

  strictEqual(state.eax, 0x1234_ffff);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "SF"), true);
});

test("cmp_equal_sets_zf_without_write", () => {
  const state = createCpuState({ eax: 5, eip: startAddress });

  execute(state, [0x81, 0xf8, 0x05, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 5);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
});

test("cmp_less_unsigned_sets_cf", () => {
  const state = createCpuState({ eax: 1, eip: startAddress });

  execute(state, [0x81, 0xf8, 0x02, 0x00, 0x00, 0x00]);

  strictEqual(state.eax, 1);
  strictEqual(getFlag(state, "CF"), true);
  strictEqual(getFlag(state, "ZF"), false);
});

test("cmp_imm8_sign_extended", () => {
  const state = createCpuState({ eax: 0, eip: startAddress });

  execute(state, [0x83, 0xf8, 0xff]);

  strictEqual(state.eax, 0);
  strictEqual(getFlag(state, "CF"), true);
});

test("cmp_word_sets_sf_from_bit15", () => {
  const state = createCpuState({ eax: 0x1234_8000, eip: startAddress });

  execute(state, [0x66, 0x81, 0xf8, 0x00, 0x00]);

  strictEqual(state.eax, 0x1234_8000);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "CF"), false);
});

test("test_sets_zf_without_write", () => {
  const state = createCpuState({ eax: 0x10, ebx: 0x20, eip: startAddress });

  execute(state, [0x85, 0xd8]);

  strictEqual(state.eax, 0x10);
  strictEqual(state.ebx, 0x20);
  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("test_byte_sets_sf_from_bit7", () => {
  const state = createCpuState({ eax: 0x80, eip: startAddress });

  execute(state, [0xa8, 0xff]);

  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("test_sets_sf_from_bit31", () => {
  const state = createCpuState({ eax: 0x8000_0000, ebx: 0xffff_ffff, eip: startAddress });

  execute(state, [0x85, 0xd8]);

  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "ZF"), false);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "OF"), false);
});

test("test_sets_pf_from_low_byte", () => {
  const state = createCpuState({ eax: 0x80, ebx: 0xff, eip: startAddress });

  execute(state, [0x85, 0xd8]);

  strictEqual(getFlag(state, "PF"), false);
  strictEqual(getFlag(state, "SF"), false);
});

test("direct executor evaluates synthetic semantic flag writes", () => {
  // All modeled flags start set so written, cleared, and preserved cells differ.
  const state = createCpuState({ eip: startAddress, CF: 1, PF: 1, AF: 1, ZF: 1, SF: 1, OF: 1 });
  const instruction = syntheticInstruction((s) => {
    const low = s.project(8, 0x1ff);

    s.writeFlags({
      cells: {
        ZF: s.flagExpr(s.compare(8, "eq", low, 0xff)),
        CF: s.flagExpr(0),
        AF: s.flagUndef()
      },
      conditions: {
        E: s.compare(8, "eq", low, 0)
      }
    });
  });

  executeDirectInstruction(state, instruction);

  strictEqual(getFlag(state, "ZF"), true);
  strictEqual(getFlag(state, "CF"), false);
  strictEqual(getFlag(state, "AF"), false);
  strictEqual(getFlag(state, "SF"), true);
  strictEqual(getFlag(state, "PF"), true);
  strictEqual(getFlag(state, "OF"), true);
});

function execute(state: ReturnType<typeof createCpuState>, values: readonly number[]): void {
  const decoded = ok(decodeBytes(values, state.eip));

  executeDirectInstruction(state, decoded);
}

function syntheticInstruction(semantics: SemanticTemplate): IsaDecodedInstruction {
  return {
    spec: {
      id: "synthetic.flags-write",
      mnemonic: "synthetic",
      opcode: [],
      format: { syntax: "synthetic" },
      semantics
    },
    address: startAddress,
    length: 1,
    nextEip: startAddress + 1,
    operands: [],
    raw: []
  };
}
