import { chromium } from 'playwright';
import { mkdir } from 'fs/promises';

const SCREENSHOTS_DIR = '/Users/alexanderollman/CodeNomad/test-screenshots';
const TEST_PROJECT_DIR = '/Users/alexanderollman/test-threejs-project';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  // Ensure screenshots directory exists
  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: false,
    slowMo: 100
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();

  try {
    console.log('1. Navigating to CodeNomad UI...');
    await page.goto('http://localhost:9898', { waitUntil: 'networkidle' });
    await sleep(2000);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/01-initial-load.png`, fullPage: true });
    console.log('   Screenshot: 01-initial-load.png');

    console.log('2. Looking at the folder selection interface...');
    await sleep(1000);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/02-folder-selection.png`, fullPage: true });
    console.log('   Screenshot: 02-folder-selection.png');

    // Try to find and click a "Browse" or folder selection button
    console.log('3. Looking for folder selection options...');

    // Check for browse folder button or input
    const browseButton = await page.$('button:has-text("Browse"), button:has-text("Select Folder"), button:has-text("Open")');
    if (browseButton) {
      console.log('   Found browse button');
    }

    // Look for a path input field
    const pathInput = await page.$('input[type="text"], input[placeholder*="path"], input[placeholder*="folder"]');
    if (pathInput) {
      console.log('   Found path input, typing test project path...');
      await pathInput.fill(TEST_PROJECT_DIR);
      await sleep(500);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/03-path-entered.png`, fullPage: true });
      console.log('   Screenshot: 03-path-entered.png');
    }

    // Look for and click a submit or go button
    const submitButton = await page.$('button:has-text("Go"), button:has-text("Open"), button:has-text("Start"), button[type="submit"]');
    if (submitButton) {
      console.log('   Found submit button, clicking...');
      await submitButton.click();
      await sleep(3000);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/04-after-submit.png`, fullPage: true });
      console.log('   Screenshot: 04-after-submit.png');
    }

    // Wait for workspace to load
    console.log('4. Waiting for workspace to initialize...');
    await sleep(5000);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/05-workspace-loaded.png`, fullPage: true });
    console.log('   Screenshot: 05-workspace-loaded.png');

    // Look for a chat/prompt input
    console.log('5. Looking for chat input...');
    const chatInput = await page.$('textarea, input[type="text"][placeholder*="message"], input[type="text"][placeholder*="prompt"], [contenteditable="true"]');
    if (chatInput) {
      console.log('   Found chat input, typing prompt...');
      await chatInput.focus();
      await chatInput.fill('Create a simple Three.js website with a rotating cube. Include an index.html file with embedded JavaScript that imports Three.js from CDN and displays a rotating 3D cube with lighting.');
      await sleep(1000);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/06-prompt-entered.png`, fullPage: true });
      console.log('   Screenshot: 06-prompt-entered.png');

      // Send the message
      const sendButton = await page.$('button:has-text("Send"), button[type="submit"], button[aria-label*="send"]');
      if (sendButton) {
        console.log('   Clicking send button...');
        await sendButton.click();
      } else {
        // Try pressing Enter
        console.log('   Pressing Enter to send...');
        await chatInput.press('Enter');
      }

      // Wait for response
      console.log('6. Waiting for AI response...');
      await sleep(10000);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/07-response-streaming.png`, fullPage: true });
      console.log('   Screenshot: 07-response-streaming.png');

      await sleep(20000);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/08-response-progress.png`, fullPage: true });
      console.log('   Screenshot: 08-response-progress.png');

      await sleep(30000);
      await page.screenshot({ path: `${SCREENSHOTS_DIR}/09-response-complete.png`, fullPage: true });
      console.log('   Screenshot: 09-response-complete.png');
    } else {
      console.log('   No chat input found!');
    }

    // Final screenshot
    console.log('7. Taking final screenshot...');
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/10-final-state.png`, fullPage: true });
    console.log('   Screenshot: 10-final-state.png');

    // Explore UI elements
    console.log('\n8. Exploring UI structure...');
    const buttons = await page.$$('button');
    console.log(`   Found ${buttons.length} buttons`);

    const inputs = await page.$$('input, textarea');
    console.log(`   Found ${inputs.length} input fields`);

    // Get page HTML structure for analysis
    const pageTitle = await page.title();
    console.log(`   Page title: ${pageTitle}`);

  } catch (error) {
    console.error('Error during test:', error.message);
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/error-state.png`, fullPage: true });
  } finally {
    console.log('\nTest complete! Screenshots saved to:', SCREENSHOTS_DIR);
    console.log('Keeping browser open for 30 seconds for manual inspection...');
    await sleep(30000);
    await browser.close();
  }
}

main().catch(console.error);
