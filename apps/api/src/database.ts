import { PrismaClient } from '@prisma/client';

let client: PrismaClient | undefined;

// Lazy initialization keeps imports and unit tests independent of a database.
export function getDatabase(): PrismaClient {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  client ??= new PrismaClient({ log: [] });
  return client;
}

export async function connectDatabase(): Promise<void> {
  await getDatabase().$connect();
}

export async function disconnectDatabase(): Promise<void> {
  const current = client;
  client = undefined;
  await current?.$disconnect();
}
