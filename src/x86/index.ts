import { defineIsa } from "./defs/dsl.js";
import { ADC, ADD, AND, DEC, INC, NEG, NOT, OR, SBB, SUB, XOR } from "./defs/alu.js";
import { AAA, AAD, AAM, AAS, DAA, DAS } from "./defs/bcd-ascii.js";
import { BSF, BSR, BT, BTC, BTR, BTS } from "./defs/bits.js";
import { BSWAP } from "./defs/byte-swap.js";
import { CMPXCHG, CMPXCHG8B, XADD } from "./defs/compare-exchange.js";
import { CALL, ENTER, JCC, JECXZ, JMP, LOOP, LOOPE, LOOPNE, RET } from "./defs/control.js";
import { CMP, TEST } from "./defs/cmp-test.js";
import { DIV, IDIV } from "./defs/div.js";
import { CLC, CLD, CMC, LAHF, SAHF, STC, STD, XLAT } from "./defs/flags.js";
import { LEA } from "./defs/lea.js";
import { INT, INT3, INTO, NOP, WAIT } from "./defs/misc.js";
import { CMOVCC, MOV, MOVSX, MOVZX } from "./defs/mov.js";
import { IMUL, MUL } from "./defs/mul.js";
import { SETCC } from "./defs/setcc.js";
import { RCL, RCR, ROL, ROR, SAR, SHL, SHLD, SHR, SHRD } from "./defs/shift.js";
import { CBW, CDQ, CWD, CWDE } from "./defs/sign-extend.js";
import { LEAVE, POP, POPA, POPAD, POPF, POPFD, PUSH, PUSHA, PUSHAD, PUSHF, PUSHFD } from "./defs/stack.js";
import { CMPS, LODS, MOVS, SCAS, STOS } from "./defs/strings.js";
import { XCHG } from "./defs/xchg.js";

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
