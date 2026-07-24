const physicalRamMinimumPages = 1;

export const physicalRamResourceDefinition = {
  id: "memory.guest",
  name: "guest",
  limits: { minPages: physicalRamMinimumPages }
} as const;
