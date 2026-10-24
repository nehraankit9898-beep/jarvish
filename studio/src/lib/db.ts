import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const isProd = process.env.NODE_ENV === 'production'
// the test runner sets NODE_ENV=test — query logging would flood the output
// with every statement (and its parameters)
const isTest = process.env.NODE_ENV === 'test'

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Never log full query parameters in any environment — they can contain
    // user prompts, conversation content and secrets. Only log errors.
    log: ['error'],
  })

if (!isProd) globalForPrisma.prisma = db