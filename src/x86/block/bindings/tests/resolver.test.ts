import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding,
  dynamicRmBinding,
  fixedMemBinding,
  fixedRegBinding,
  valueBinding
} from "#x86/block/bindings/resolver.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#x86/expr/builders.js";
import { bitsUse } from "#x86/expr/uses.js";
import { registerAlias, registerAliasByIndex } from "#x86/isa/registers.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { StorageRef } from "#x86/ir/model/types.js";

test("fixed +r opcode operands bind to the selected register without rereading opcode bits", () => {
  const eaxOperand = fixedRegBinding(registerAliasByIndex(32, 0));
  const resolver = new BindingResolver({ operands: [eaxOperand] });

  deepStrictEqual(resolver.operand(0), fixedRegBinding(registerAlias("eax")));
  deepStrictEqual(resolver.storage({ kind: "operand", index: 0 }), fixedRegBinding(registerAlias("eax")));
  deepStrictEqual(resolver.readEffect(eaxOperand, bitsUse(0xff)), {
    dependencies: [
      { kind: "reg", reg: "eax", mask: 0xff }
    ]
  });
  deepStrictEqual(resolver.writeEffect(eaxOperand), {
    targetDependencies: [],
    clobbers: [
      { kind: "reg", reg: "eax", mask: 0xffff_ffff }
    ]
  });
});

test("explicit base-register storage narrows to canonical register aliases", () => {
  const resolver = new BindingResolver();

  deepStrictEqual(resolver.storage({ kind: "reg", reg: "eax" }, 8), fixedRegBinding(registerAlias("al")));
  deepStrictEqual(resolver.storage({ kind: "reg", reg: "ecx" }, 16), fixedRegBinding(registerAlias("cx")));
  throws(
    () => resolver.storage({ kind: "reg", reg: "esp" }, 8),
    /esp has no 8-bit register alias/
  );
});

test("dynamic ModRM register operands preserve the runtime register-index expression", () => {
  const index = exprConst(2);
  const binding = dynamicRegBinding(index, 16);
  const resolver = new BindingResolver({ operands: [binding] });

  deepStrictEqual(resolver.operand(0), binding);
  deepStrictEqual(resolver.storage({ kind: "operand", index: 0 }), binding);
  deepStrictEqual(resolver.readEffect(binding), {
    dependencies: [
      { kind: "reg", reg: "eax", mask: 0xffff },
      { kind: "reg", reg: "ecx", mask: 0xffff },
      { kind: "reg", reg: "edx", mask: 0xffff },
      { kind: "reg", reg: "ebx", mask: 0xffff },
      { kind: "reg", reg: "esp", mask: 0xffff },
      { kind: "reg", reg: "ebp", mask: 0xffff },
      { kind: "reg", reg: "esi", mask: 0xffff },
      { kind: "reg", reg: "edi", mask: 0xffff }
    ]
  });
  deepStrictEqual(resolver.writeEffect(binding), {
    targetDependencies: [],
    clobbers: [
      { kind: "reg", reg: "eax", mask: 0xffff },
      { kind: "reg", reg: "ecx", mask: 0xffff },
      { kind: "reg", reg: "edx", mask: 0xffff },
      { kind: "reg", reg: "ebx", mask: 0xffff },
      { kind: "reg", reg: "esp", mask: 0xffff },
      { kind: "reg", reg: "ebp", mask: 0xffff },
      { kind: "reg", reg: "esi", mask: 0xffff },
      { kind: "reg", reg: "edi", mask: 0xffff }
    ]
  });
});

test("write effects expose target-selection dependencies separately from clobbers", () => {
  const resolver = new BindingResolver();
  const dynamicReg = dynamicRegBinding(exprInput({ kind: "reg", reg: "edx" }), 32);
  const dynamicRm = dynamicRmBinding(
    exprInput({ kind: "flag", flag: "ZF" }),
    exprInput({ kind: "reg", reg: "ecx" }),
    exprBinary("add", exprInput({ kind: "reg", reg: "esi" }), exprConst(4)),
    8
  );

  deepStrictEqual(resolver.writeEffect(dynamicReg), {
    targetDependencies: [
      { kind: "reg", reg: "edx", mask: 0xffff_ffff }
    ],
    clobbers: [
      { kind: "reg", reg: "eax", mask: 0xffff_ffff },
      { kind: "reg", reg: "ecx", mask: 0xffff_ffff },
      { kind: "reg", reg: "edx", mask: 0xffff_ffff },
      { kind: "reg", reg: "ebx", mask: 0xffff_ffff },
      { kind: "reg", reg: "esp", mask: 0xffff_ffff },
      { kind: "reg", reg: "ebp", mask: 0xffff_ffff },
      { kind: "reg", reg: "esi", mask: 0xffff_ffff },
      { kind: "reg", reg: "edi", mask: 0xffff_ffff }
    ]
  });
  deepStrictEqual(resolver.writeEffect(dynamicRm, bitsUse(0xff)), {
    targetDependencies: [
      { kind: "reg", reg: "ecx", mask: 0xffff_ffff },
      { kind: "reg", reg: "esi", mask: 0xffff_ffff },
      { kind: "flag", flag: "ZF" }
    ],
    clobbers: [
      { kind: "reg", reg: "eax", mask: 0xffff },
      { kind: "reg", reg: "ecx", mask: 0xffff },
      { kind: "reg", reg: "edx", mask: 0xffff },
      { kind: "reg", reg: "ebx", mask: 0xffff },
      { kind: "memory" }
    ]
  });
});

test("dynamic r/m operands expose register-or-memory address, dependencies, and clobbers", () => {
  const address = exprConst(0x2000);
  const binding = dynamicRmBinding(exprConst(1), exprConst(3), address, 8);
  const resolver = new BindingResolver({ operands: [binding] });

  deepStrictEqual(resolver.address({ kind: "operand", index: 0 }), address);
  deepStrictEqual(resolver.readEffect(binding), {
    dependencies: [
      { kind: "reg", reg: "eax", mask: 0xffff },
      { kind: "reg", reg: "ecx", mask: 0xffff },
      { kind: "reg", reg: "edx", mask: 0xffff },
      { kind: "reg", reg: "ebx", mask: 0xffff },
      { kind: "memory" }
    ]
  });
  deepStrictEqual(resolver.writeEffect(binding, bitsUse(0x0f)), {
    targetDependencies: [],
    clobbers: [
      { kind: "reg", reg: "eax", mask: 0x0f0f },
      { kind: "reg", reg: "ecx", mask: 0x0f0f },
      { kind: "reg", reg: "edx", mask: 0x0f0f },
      { kind: "reg", reg: "ebx", mask: 0x0f0f },
      { kind: "memory" }
    ]
  });
});

test("immediate and relative target operands are read-only value bindings", () => {
  const immediate = valueBinding(exprConst(0x7f));
  const relativeTarget = valueBinding(exprBinary(
    "add",
    exprInput({ kind: "reg", reg: "eax" }),
    exprConst(4)
  ));
  const resolver = new BindingResolver({
    operands: [immediate, relativeTarget]
  });

  deepStrictEqual(resolver.operand(0), immediate);
  deepStrictEqual(resolver.readEffect(immediate), {
    dependencies: []
  });
  deepStrictEqual(resolver.readEffect(relativeTarget), {
    dependencies: [
      { kind: "reg", reg: "eax", mask: 0xffff_ffff }
    ]
  });
  throws(
    () => resolver.storage({ kind: "operand", index: 0 }),
    /operand 0 is a value binding, not storage/
  );
});

test("fixed memory bindings depend on their address expression and clobber guest memory", () => {
  const address = exprInput({ kind: "reg", reg: "esi" });
  const binding = fixedMemBinding(address, 32);
  const resolver = new BindingResolver();

  deepStrictEqual(resolver.readEffect(binding), {
    dependencies: [
      { kind: "reg", reg: "esi", mask: 0xffff_ffff },
      { kind: "memory" }
    ]
  });
  deepStrictEqual(resolver.writeEffect(binding), {
    targetDependencies: [
      { kind: "reg", reg: "esi", mask: 0xffff_ffff }
    ],
    clobbers: [
      { kind: "memory" }
    ]
  });
});

test("a neutral block-style storage read can use bindings without importing interpreter or JIT modules", () => {
  const operandStorage: StorageRef = { kind: "operand", index: 0 };
  const explicitReg: StorageRef = { kind: "reg", reg: "cl" };
  const explicitMem: StorageRef = { kind: "mem", address: { kind: "var", id: 7 } };
  const memAddress = exprInput({ kind: "reg", reg: "edi" });
  const resolver = new BindingResolver({
    operands: [fixedRegBinding(registerAlias("ebx"))],
    irValue(value) {
      strictEqual(value.kind, "var");
      strictEqual(value.id, 7);
      return memAddress;
    }
  });

  deepStrictEqual(neutralStorageRead(resolver, operandStorage), fixedRegBinding(registerAlias("ebx")));
  deepStrictEqual(neutralStorageRead(resolver, explicitReg), fixedRegBinding(registerAlias("cl")));
  deepStrictEqual(neutralStorageRead(resolver, explicitMem, 16), fixedMemBinding(memAddress, 16));
});

function neutralStorageRead(
  resolver: BindingResolver,
  source: StorageRef,
  accessWidth: OperandWidth = 32
) {
  return resolver.storage(source, accessWidth);
}
