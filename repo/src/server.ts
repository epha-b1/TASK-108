import app from './app';
import { env } from './config/environment';
import { getPrisma } from './config/database';
import { logger } from './utils/logger';
import { startScheduler } from './services/scheduler.service';

async function main(): Promise<void> {
  const prisma = getPrisma();

  try {
    await prisma.$connect();
    logger.info('Database connected');
  } catch (error) {
    logger.error('Failed to connect to database', { error });
    process.exit(1);
  }

  // Start background jobs (outbox, cap reset, cleanup)
  startScheduler();

  app.listen(env.port, () => {
    logger.info(`Server started on port ${env.port}`);
  });
}

main();
