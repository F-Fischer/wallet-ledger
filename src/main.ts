import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { serveSite } from './site.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // HMAC webhook signatures need the exact bytes
  serveSite(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
// Not awaited on purpose: on Vercel, `listen` resolves only after this module
// finishes loading, so a top-level await deadlocks the function's init.
bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
