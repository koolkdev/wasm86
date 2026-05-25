import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  BindingResolver,
  dynamicRegBinding,
  memBinding,
  regBinding,
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

test("expanded +r opcode operands bind to the selected register without rereading opcode bits", () => {
  const eaxOperand = regBinding(registerAliasByIndex(32, 0));
  const resolver = new BindingResolver({ operands: [eaxOperand] });

  deepStrictEqual(resolver.operand(0), regBinding(registerAlias("eax")));
  deepStrictEqual(resolver.storage({ kind: "operand", index: 0 }), regBinding(registerAlias("eax")));
  deepStrictEqual(resolver.readDeps(eaxOperand, bitsUse(0xff)), [
    { kind: "reg", reg: "eax", mask: 0xff }
  ]);
  deepStrictEqual(resolver.writeDeps(eaxOperand), []);
  deepStrictEqual(resolver.clobbers(eaxOperand), [
    { kind: "reg", reg: "eax", mask: 0xffff_ffff }
  ]);
});

test("explicit base-register storage narrows to canonical register aliases", () => {
  const resolver = new BindingResolver();

  deepStrictEqual(resolver.storage({ kind: "reg", reg: "eax" }, 8), regBinding(registerAlias("al")));
  deepStrictEqual(resolver.storage({ kind: "reg", reg: "ecx" }, 16), regBinding(registerAlias("cx")));
  throws(
    () => resolver.storage({ kind: "reg", reg: "esp" }, 8),
    /esp has no 8-bit register alias/
  );
});

test("dynamic ModRM register operands preserve the runtime register-index expression", () => {
  const index = exprInput({ kind: "flag", flag: "ZF" });
  const binding = dynamicRegBinding(index, 16);
  const resolver = new BindingResolver({ operands: [binding] });

  deepStrictEqual(resolver.operand(0), binding);
  deepStrictEqual(resolver.storage({ kind: "operand", index: 0 }), binding);
  deepStrictEqual(resolver.readDeps(binding), [
    { kind: "reg", reg: "eax", mask: 0xffff },
    { kind: "reg", reg: "ecx", mask: 0xffff },
    { kind: "reg", reg: "edx", mask: 0xffff },
    { kind: "reg", reg: "ebx", mask: 0xffff },
    { kind: "reg", reg: "esp", mask: 0xffff },
    { kind: "reg", reg: "ebp", mask: 0xffff },
    { kind: "reg", reg: "esi", mask: 0xffff },
    { kind: "reg", reg: "edi", mask: 0xffff },
    { kind: "flag", flag: "ZF" }
  ]);
  deepStrictEqual(resolver.writeDeps(binding), [
    { kind: "flag", flag: "ZF" }
  ]);
  deepStrictEqual(resolver.clobbers(binding), [
    { kind: "reg", reg: "eax", mask: 0xffff },
    { kind: "reg", reg: "ecx", mask: 0xffff },
    { kind: "reg", reg: "edx", mask: 0xffff },
    { kind: "reg", reg: "ebx", mask: 0xffff },
    { kind: "reg", reg: "esp", mask: 0xffff },
    { kind: "reg", reg: "ebp", mask: 0xffff },
    { kind: "reg", reg: "esi", mask: 0xffff },
    { kind: "reg", reg: "edi", mask: 0xffff }
  ]);
});

test("ModRM r/m register and memory paths use separate storage bindings", () => {
  const address = exprBinary("add", exprInput({ kind: "reg", reg: "esi" }), exprConst(4));
  const registerPath = dynamicRegBinding(exprConst(3), 8);
  const memoryPath = memBinding(address, 8);
  const registerResolver = new BindingResolver({ operands: [registerPath] });
  const memoryResolver = new BindingResolver({ operands: [memoryPath] });

  throws(
    () => registerResolver.address({ kind: "operand", index: 0 }),
    /dynamicReg binding has no address/
  );
  deepStrictEqual(memoryResolver.address({ kind: "operand", index: 0 }), address);

  deepStrictEqual(registerResolver.readDeps(registerPath, bitsUse(0xff)), [
    { kind: "reg", reg: "eax", mask: 0xffff },
    { kind: "reg", reg: "ecx", mask: 0xffff },
    { kind: "reg", reg: "edx", mask: 0xffff },
    { kind: "reg", reg: "ebx", mask: 0xffff }
  ]);
  deepStrictEqual(registerResolver.writeDeps(registerPath), []);
  deepStrictEqual(registerResolver.clobbers(registerPath, bitsUse(0x0f)), [
    { kind: "reg", reg: "eax", mask: 0x0f0f },
    { kind: "reg", reg: "ecx", mask: 0x0f0f },
    { kind: "reg", reg: "edx", mask: 0x0f0f },
    { kind: "reg", reg: "ebx", mask: 0x0f0f }
  ]);

  deepStrictEqual(memoryResolver.readDeps(memoryPath), [
    { kind: "reg", reg: "esi", mask: 0xffff_ffff },
    { kind: "memory" }
  ]);
  deepStrictEqual(memoryResolver.writeDeps(memoryPath), [
    { kind: "reg", reg: "esi", mask: 0xffff_ffff }
  ]);
  deepStrictEqual(memoryResolver.clobbers(memoryPath, bitsUse(0x0f)), [
    { kind: "memory" }
  ]);
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
  deepStrictEqual(resolver.readDeps(immediate), []);
  deepStrictEqual(resolver.readDeps(relativeTarget), [
    { kind: "reg", reg: "eax", mask: 0xffff_ffff }
  ]);
  throws(
    () => resolver.storage({ kind: "operand", index: 0 }),
    /operand 0 is a value binding, not storage/
  );
});

test("memory bindings read through address plus memory and write by clobbering memory", () => {
  const address = exprInput({ kind: "reg", reg: "esi" });
  const binding = memBinding(address, 32);
  const resolver = new BindingResolver();

  deepStrictEqual(resolver.readDeps(binding), [
    { kind: "reg", reg: "esi", mask: 0xffff_ffff },
    { kind: "memory" }
  ]);
  deepStrictEqual(resolver.writeDeps(binding), [
    { kind: "reg", reg: "esi", mask: 0xffff_ffff }
  ]);
  deepStrictEqual(resolver.clobbers(binding), [
    { kind: "memory" }
  ]);
});

test("a neutral block-style storage read can use bindings without importing interpreter or JIT modules", () => {
  const operandStorage: StorageRef = { kind: "operand", index: 0 };
  const explicitReg: StorageRef = { kind: "reg", reg: "cl" };
  const explicitMem: StorageRef = { kind: "mem", address: { kind: "var", id: 7 } };
  const memAddress = exprInput({ kind: "reg", reg: "edi" });
  const resolver = new BindingResolver({
    operands: [regBinding(registerAlias("ebx"))],
    irValue(value) {
      strictEqual(value.kind, "var");
      strictEqual(value.id, 7);
      return memAddress;
    }
  });

  deepStrictEqual(neutralStorageRead(resolver, operandStorage), regBinding(registerAlias("ebx")));
  deepStrictEqual(neutralStorageRead(resolver, explicitReg), regBinding(registerAlias("cl")));
  deepStrictEqual(neutralStorageRead(resolver, explicitMem, 16), memBinding(memAddress, 16));
});

function neutralStorageRead(
  resolver: BindingResolver,
  source: StorageRef,
  accessWidth: OperandWidth = 32
) {
  return resolver.storage(source, accessWidth);
}
