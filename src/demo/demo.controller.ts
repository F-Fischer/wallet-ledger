import { Controller, Get, Header } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// public/ sits next to src/ and dist/, so the path works from both.
const PAGE = fileURLToPath(new URL('../../public/index.html', import.meta.url));

/** Serves the single-file demo page at `/`. It only calls the public API. */
@Controller()
export class DemoController {
  private html?: string;

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-cache')
  index(): string {
    this.html ??= readFileSync(PAGE, 'utf8');
    return this.html;
  }
}
