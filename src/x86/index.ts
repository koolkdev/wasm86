import { defineIsa } from "./schema/builders.js";
import { ADC, ADD, AND, DEC, INC, NEG, NOT, OR, SBB, SUB, XOR } from "./defs/alu.js";
import { CALL, JCC, JMP, RET } from "./defs/control.js";
import { CMP, TEST } from "./defs/cmp-test.js";
import { LEA } from "./defs/lea.js";
import { INT, NOP } from "./defs/misc.js";
import { CMOVCC, MOV, MOVSX, MOVZX } from "./defs/mov.js";
import { SETCC } from "./defs/setcc.js";
import { SAR, SHL, SHR } from "./defs/shift.js";
import { LEAVE, POP, POPFD, PUSH, PUSHFD } from "./defs/stack.js";
import { XCHG } from "./defs/xchg.js";

export const X86_32_CORE = defineIsa({
  name: "x86-32-core",
  mnemonics: [
    NOP,
    MOV,
    MOVZX,
    MOVSX,
    ...CMOVCC,
    ...SETCC,
    XCHG,
    LEA,
    ADD,
    ADC,
    OR,
    SBB,
    AND,
    SUB,
    XOR,
    INC,
    DEC,
    NOT,
    NEG,
    SHL,
    SHR,
    SAR,
    CMP,
    TEST,
    PUSH,
    POP,
    PUSHFD,
    POPFD,
    LEAVE,
    JMP,
    CALL,
    RET,
    INT,
    ...JCC
  ]
});

export type X86CoreInstruction = (typeof X86_32_CORE.instructions)[number];
