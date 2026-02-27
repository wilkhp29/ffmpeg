#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const { chromium } = require('playwright');

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const session = args.session;
  if (!session) {
    throw new Error('Use --session <nome-da-sessao>. Ex: --session x-main');
  }

  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(session)) {
    throw new Error('Sessao invalida. Use apenas letras, numeros, ponto, underscore e hifen.');
  }

  const storageDir = path.resolve(args.storageDir || process.env.STORAGE_DIR || './storageStates');
  const url = args.url || 'https://x.com/login';

  await fs.mkdir(storageDir, { recursive: true });

  const sessionPath = path.join(storageDir, `${session}.json`);

  let storageState;
  try {
    const stat = await fs.stat(sessionPath);
    if (stat.isFile()) {
      storageState = sessionPath;
      console.log(`[save_state] carregando estado existente: ${sessionPath}`);
    }
  } catch {
    // no-op
  }

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox']
  });

  const context = await browser.newContext(
    storageState
      ? {
          storageState
        }
      : undefined
  );

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

  console.log('[save_state] finalize o login no navegador aberto.');
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    await rl.question('[save_state] pressione ENTER para salvar o storageState... ');
  } finally {
    rl.close();
  }

  await context.storageState({ path: sessionPath });
  await browser.close();

  console.log(`[save_state] salvo em: ${sessionPath}`);
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--session') {
      parsed.session = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--url') {
      parsed.url = argv[i + 1];
      i += 1;
      continue;
    }

    if (token === '--storage-dir') {
      parsed.storageDir = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return parsed;
}

main().catch((error) => {
  console.error('[save_state] erro:', error.message || error);
  process.exit(1);
});
