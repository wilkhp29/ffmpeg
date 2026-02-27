const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  console.log('--- CAPTURA DE SESSÃO TWITTER ---');
  console.log('1. Faça login manualmente no Twitter na janela que abriu.');
  console.log('2. Quando estiver na Home (logado), volte aqui e pressione ENTER.');

  await page.goto('https://x.com/i/flow/login');

  process.stdin.on('data', async () => {
    const storageState = await context.storageState();
    const filePath = path.join(__dirname, 'twitter_session.json');
    fs.writeFileSync(filePath, JSON.stringify(storageState, null, 2));

    console.log(`\n✅ Sessão salva com sucesso em: ${filePath}`);
    console.log('Agora você deve enviar esse arquivo para o servidor usando o comando que eu vou te passar.');

    await browser.close();
    process.exit();
  });
})();
