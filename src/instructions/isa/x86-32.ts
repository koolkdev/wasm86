import { defineIsa } from "./dsl.js";
import { ADC, ADD, AND, CMP, DEC, INC, NEG, NOT, OR, SBB, SUB, XOR } from "./definitions/alu.js";
import { AAA, AAD, AAM, AAS, DAA, DAS } from "./definitions/bcd-ascii.js";
import { BSF, BSR, BT, BTC, BTR, BTS } from "./definitions/bits.js";
import { BSWAP } from "./definitions/byte-swap.js";
import { CMPXCHG, CMPXCHG8B, XADD } from "./definitions/compare-exchange.js";
import { CALL, ENTER, JCC, JECXZ, JMP, LOOP, LOOPE, LOOPNE, RET } from "./definitions/control.js";
import { TEST } from "./definitions/test.js";
import { DIV, IDIV } from "./definitions/div.js";
import { CLC, CLD, CMC, LAHF, SAHF, STC, STD, XLAT } from "./definitions/flags.js";
import { LEA } from "./definitions/lea.js";
import { INT, INT3, INTO, NOP, WAIT } from "./definitions/misc.js";
import { CMOVCC, MOV, MOVSX, MOVZX } from "./definitions/mov.js";
import { IMUL, MUL } from "./definitions/mul.js";
import { SETCC } from "./definitions/setcc.js";
import { RCL, RCR, ROL, ROR, SAR, SHL, SHLD, SHR, SHRD } from "./definitions/shift.js";
import { CBW, CDQ, CWD, CWDE } from "./definitions/sign-extend.js";
import {
  LEAVE,
  POP,
  POPA,
  POPAD,
  POPF,
  POPFD,
  PUSH,
  PUSHA,
  PUSHAD,
  PUSHF,
  PUSHFD
} from "./definitions/stack.js";
import { CMPS, LODS, MOVS, SCAS, STOS } from "./definitions/strings.js";
import { XCHG } from "./definitions/xchg.js";

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
