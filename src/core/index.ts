import { defineIsa } from "./instructions/dsl.js";
import { ADC, ADD, AND, DEC, INC, NEG, NOT, OR, SBB, SUB, XOR } from "./instructions/alu.js";
import { AAA, AAD, AAM, AAS, DAA, DAS } from "./instructions/bcd-ascii.js";
import { BSF, BSR, BT, BTC, BTR, BTS } from "./instructions/bits.js";
import { BSWAP } from "./instructions/byte-swap.js";
import { CMPXCHG, CMPXCHG8B, XADD } from "./instructions/compare-exchange.js";
import { CALL, ENTER, JCC, JECXZ, JMP, LOOP, LOOPE, LOOPNE, RET } from "./instructions/control.js";
import { CMP, TEST } from "./instructions/cmp-test.js";
import { DIV, IDIV } from "./instructions/div.js";
import { CLC, CLD, CMC, LAHF, SAHF, STC, STD, XLAT } from "./instructions/flags.js";
import { LEA } from "./instructions/lea.js";
import { INT, INT3, INTO, NOP, WAIT } from "./instructions/misc.js";
import { CMOVCC, MOV, MOVSX, MOVZX } from "./instructions/mov.js";
import { IMUL, MUL } from "./instructions/mul.js";
import { SETCC } from "./instructions/setcc.js";
import { RCL, RCR, ROL, ROR, SAR, SHL, SHLD, SHR, SHRD } from "./instructions/shift.js";
import { CBW, CDQ, CWD, CWDE } from "./instructions/sign-extend.js";
import { LEAVE, POP, POPA, POPAD, POPF, POPFD, PUSH, PUSHA, PUSHAD, PUSHF, PUSHFD } from "./instructions/stack.js";
import { CMPS, LODS, MOVS, SCAS, STOS } from "./instructions/strings.js";
import { XCHG } from "./instructions/xchg.js";

export const X86_32_CORE = defineIsa({
  name: "x86-32-core",
  instructionLengthLimit: 15,
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
    DAA,
    DAS,
    XOR,
    AAA,
    AAS,
    INC,
    DEC,
    NOT,
    NEG,
    MUL,
    IMUL,
    DIV,
    IDIV,
    BSWAP,
    CLC,
    STC,
    CMC,
    CLD,
    STD,
    LAHF,
    SAHF,
    XLAT,
    MOVS,
    CMPS,
    STOS,
    LODS,
    SCAS,
    CBW,
    CWDE,
    CWD,
    CDQ,
    AAM,
    AAD,
    ROL,
    ROR,
    RCL,
    RCR,
    SHL,
    SHLD,
    SHR,
    SHRD,
    SAR,
    BT,
    BTS,
    BTR,
    BTC,
    BSF,
    BSR,
    CMPXCHG,
    XADD,
    CMPXCHG8B,
    CMP,
    TEST,
    PUSH,
    POP,
    PUSHAD,
    PUSHA,
    POPAD,
    POPA,
    PUSHF,
    PUSHFD,
    POPF,
    POPFD,
    LEAVE,
    JMP,
    CALL,
    RET,
    ENTER,
    JECXZ,
    LOOP,
    LOOPE,
    LOOPNE,
    WAIT,
    INT,
    INT3,
    INTO,
    ...JCC
  ]
});

export type X86CoreInstruction = (typeof X86_32_CORE.instructions)[number];
