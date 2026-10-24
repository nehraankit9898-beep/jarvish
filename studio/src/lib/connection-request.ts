import { z } from 'zod';

/** Bound request sizes before any paid/network provider call. */
export const connectionRequestSchema = z.object({
  provider: z.string().trim().min(1).max(80),
  apiKey: z.string().max(8192).optional(),
  model: z.string().trim().max(256).optional(),
  baseUrl: z.string().trim().max(2048).optional(),
});
