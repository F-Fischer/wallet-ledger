import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Relative to the project root, like migrations/: the app runs from there
// (pnpm scripts, tests) and serverless bundles keep files at those paths.
const PAGE = join(process.cwd(), 'public', 'index.html');

/**
 * Serves the single-file demo page at `/`. It only calls the public API.
 * Read on every request (a small file) so edits show up under `start:dev`,
 * which only watches src/.
 */
@Controller()
export class DemoController {
  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-cache')
  index(): string {
    return readFileSync(PAGE, 'utf8');
  }
}
