// Second half of `npm run setup` (after `npm install`): local config, the
// Appium iOS driver, and a check of the macOS tooling the farm relies on.
// Safe to re-run; each step skips itself when already done.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const XCUITEST_DRIVER = 'xcuitest@7.26.3';
const appiumEnv = { ...process.env, APPIUM_HOME: path.join(root, '.appium2') };
const appium = path.join(root, 'node_modules/appium/index.js');
const problems = [];

function step(message) {
    console.log(`\n▸ ${message}`);
}

function commandWorks(command, args) {
    try {
        execFileSync(command, args, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) {
    console.error(`Node ${process.versions.node} is too old; install Node 22 or newer.`);
    process.exit(1);
}

step('Config (.env)');
if (existsSync(path.join(root, '.env'))) {
    console.log('  .env already exists — kept as is');
} else {
    copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    console.log('  Created .env from .env.example — set XCODE_ORG_ID (your Apple Team ID) before registering a phone');
}

step(`Appium iOS driver (${XCUITEST_DRIVER})`);
const installed = spawnSync(process.execPath, [appium, 'driver', 'list', '--installed', '--json'], { env: appiumEnv, encoding: 'utf8' });
let hasDriver = false;
try {
    hasDriver = 'xcuitest' in JSON.parse(installed.stdout || '{}');
} catch { /* not JSON — treat as not installed */ }
if (hasDriver) {
    console.log('  Already installed');
} else {
    const result = spawnSync(process.execPath, [appium, 'driver', 'install', XCUITEST_DRIVER], { env: appiumEnv, stdio: 'inherit' });
    if (result.status !== 0) problems.push('Installing the Appium XCUITest driver failed — re-run `npm run setup`');
}

step('macOS tools');
if (process.platform !== 'darwin') {
    problems.push('This machine is not a Mac. The dashboard runs anywhere, but driving iPhones needs macOS with Xcode.');
} else {
    if (!commandWorks('xcodebuild', ['-version'])) problems.push('Xcode is missing — install it from the App Store, open it once, then re-run setup');
    else console.log('  Xcode found');
    if (!commandWorks('xcrun', ['xctrace', 'version'])) problems.push('xcrun xctrace is unavailable — run `sudo xcode-select -s /Applications/Xcode.app`');
}

if (problems.length) {
    console.log('\nSetup finished with warnings:');
    for (const problem of problems) console.log(`  ⚠ ${problem}`);
} else {
    console.log('\nSetup complete.');
}
console.log('Start the farm with:  npm start');
