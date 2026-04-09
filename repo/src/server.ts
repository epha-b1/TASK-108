import app from './app';
import { env } from './config/environment';
import { getPrisma } from './config/database';
import { systemLog } from './utils/logger';
import { startScheduler } from './services/scheduler.service';

async function main(): Promise<void> {
  const prisma = getPrisma();

  try {
    await prisma.$connect();
    systemLog.info('database connected');
  } catch (error) {
    systemLog.error('database connection failed', { error });
    process.exit(1);
  }

  // Start background jobs (outbox, cap reset, cleanup)
  startScheduler();

  app.listen(env.port, () => {
    systemLog.info('server started', { port: env.port });
  });
}

main();
