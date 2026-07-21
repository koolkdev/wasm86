import { guestMemoryMinimumPages } from "./constants.js";

export const guestMemoryResourceDefinition = {
  id: "memory.guest",
  name: "guest",
  limits: { minPages: guestMemoryMinimumPages }
} as const;
