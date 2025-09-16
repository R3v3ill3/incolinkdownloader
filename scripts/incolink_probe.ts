import 'dotenv/config';
import puppeteer from 'puppeteer';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORTAL_URL = 'https://compliancelink.incolink.org.au/';

function parseFilename(disposition?: string) {
  if (!disposition) return null;
  const m = /filename\*?=(?:UTF-8'')?"?([^\";]+)"?/i.exec(disposition);
  return m ? decodeURIComponent(m[1]) : null;
}

async function waitForSelectorAny(page: puppeteer.Page, selectors: string[], timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) return el;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timeout waiting for any selector: ${selectors.join(', ')}`);
}

async function clickByText(page: puppeteer.Page, text: string) {
  const xpath = `//*[self::button or self::a][contains(normalize-space(.), "${text}")]`;
  const elHandles = await page.$x(xpath);
  if (elHandles.length) {
    await (elHandles[0] as puppeteer.ElementHandle<Element>).click();
    return true;
  }
  return false;
}

async function main() {
  const email = process.env.INCOLINK_EMAIL;
  const password = process.env.INCOLINK_PASSWORD;
  const employerNo = process.argv[2] || process.env.INCOLINK_EMPLOYER_NO || '7125150';

  if (!email || !password) {
    console.error('Set INCOLINK_EMAIL and INCOLINK_PASSWORD in .env');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH
  });
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36'
  );
  page.setDefaultNavigationTimeout(60000);

  // Log relevant network for discovery
  page.on('request', (req) => {
    const u = req.url();
    if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
      if (u.includes('invoice') || u.includes(employerNo)) {
        console.log('XHR/FETCH →', req.method(), u);
      }
    }
  });
  page.on('response', async (res) => {
    const u = res.url();
    const cd = res.headers()['content-disposition'];
    if (cd && /attachment/i.test(cd)) {
      console.log('Download response:', u, cd);
    } else if (u.includes('invoice')) {
      console.log('Response:', res.status(), u);
    }
  });

  // 1) Login
  console.log('Opening portal…', PORTAL_URL);
  await page.goto(PORTAL_URL, { waitUntil: 'networkidle2' });

  const emailInput =
    (await page.$('input[type="email"]')) ||
    (await page.$('input[placeholder*="Email" i]')) ||
    (await waitForSelectorAny(page, ['input[type="email"]', 'input[placeholder*="Email" i]']));
  await emailInput!.type(email, { delay: 20 });

  const pwInput =
    (await page.$('input[type="password"]')) ||
    (await page.$('input[placeholder*="Password" i]')) ||
    (await waitForSelectorAny(page, ['input[type="password"]', 'input[placeholder*="Password" i]']));
  await pwInput!.type(password, { delay: 20 });

  const clickedLogin =
    (await clickByText(page, 'Login')) ||
    (await clickByText(page, 'Sign in')) ||
    (await (await page.$('button[type="submit"]'))?.click().then(() => true).catch(() => false)) ||
    false;

  if (!clickedLogin) {
    throw new Error('Could not locate Login button.');
  }

  // Wait for app shell (Blazor) to mount and the employer search input to appear
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 60000 });
  const searchInput =
    (await page.$('input[placeholder*="No or Name" i]')) ||
    (await waitForSelectorAny(page, ['input[placeholder*="No or Name" i]'], 60000));

  // 2) Search employer number
  await searchInput!.click({ clickCount: 3 });
  await searchInput!.type(employerNo, { delay: 25 });
  await page.keyboard.press('Enter');

  // Wait for results to render
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 60000 });

  // 3) Pick first invoice with non-zero amount (DOM parse with fallbacks)
  // Try table rows
  let targetInvoice: string | null = null;
  try {
    const rows = await page.$$eval('table tbody tr', (trs) =>
      trs.map((tr) => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const text = tds.map((td) => (td.textContent || '').trim());
        const link = tr.querySelector('a');
        return { text, linkText: link ? (link.textContent || '').trim() : null };
      })
    );
    for (const r of rows) {
      const amountCell = r.text.find((t) => t.includes('$'));
      const amount = amountCell ? Number((amountCell.replace(/[^0-9.-]/g, ''))) : 0;
      if (r.linkText && amount > 0) {
        targetInvoice = r.linkText;
        break;
      }
    }
  } catch {
    // ignore and fallback
  }

  // Fallback: pick first anchor that looks like a numeric invoice and try to ensure non-zero by nearby text
  if (!targetInvoice) {
    const links = await page.$$eval('a', (as) =>
      as
        .map((a) => (a.textContent || '').trim())
        .filter((t) => /^\d{5,}$/.test(t))
    );
    targetInvoice = links[0] || null;
  }

  if (!targetInvoice) {
    throw new Error('Could not find a target invoice link.');
  }

  console.log('Opening invoice:', targetInvoice);
  // Click the invoice link
  const invoiceLinkXpath = `//a[normalize-space(text())="${targetInvoice}"]`;
  const [invEl] = await page.$x(invoiceLinkXpath);
  if (!invEl) throw new Error('Invoice link element not found.');
  await (invEl as puppeteer.ElementHandle<Element>).click();

  await page.waitForNetworkIdle({ idleTime: 800, timeout: 60000 });

  // 4) Click "Export Invoice Details" and capture the download
  const dlWait = page.waitForResponse((res) => {
    const cd = res.headers()['content-disposition'];
    return !!cd && /attachment/i.test(cd);
  }, { timeout: 60000 }).catch(() => null);

  const exportClicked =
    (await clickByText(page, 'Export Invoice Details')) ||
    (await clickByText(page, 'Export')) ||
    false;

  if (!exportClicked) {
    throw new Error('Could not find Export Invoice Details button.');
  }

  const res = await dlWait;
  if (!res) {
    throw new Error('Did not observe a downloadable response.');
  }

  const buf = await res.buffer();
  const fname = parseFilename(res.headers()['content-disposition']) || `invoice-${targetInvoice}.bin`;
  const outDir = path.resolve(process.cwd(), 'tmp', 'incolink');
  await fs.mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, fname);
  await fs.writeFile(outPath, buf);
  console.log('Saved export:', outPath);

  await browser.close();
}

main().catch(async (e) => {
  console.error('Probe failed:', e);
  process.exit(1);
});