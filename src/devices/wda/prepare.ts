import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDeveloperDir } from './xcode-env.js';
import { resolveBuildTargets } from './target-device.js';

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} is required in .env`);
    }
    return value;
}

function run(command: string, args: string[], options: SpawnOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'inherit', ...options });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${command} failed (${signal ?? `exit ${code}`})`));
            }
        });
    });
}

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
const driverPath = path.resolve(process.env.XCUITEST_DRIVER_PATH
    ?? '.appium2/node_modules/appium-xcuitest-driver');
const wdaRoot = path.join(driverPath, 'node_modules/appium-webdriveragent');
const projectPath = path.join(wdaRoot, 'WebDriverAgent.xcodeproj');
const touchCommandsPath = path.join(
    wdaRoot,
    'WebDriverAgentLib/Commands/FBTouchActionCommands.m',
);
// Ported to the WDA bundled with the pinned driver (xcuitest 12.1.4); see Patches/README.md.
const TESTED_WDA_VERSION = '16.1.1';
const patchPath = path.join(packageRoot, 'Patches/wda-16.1.1-farm.patch');

await Promise.all([access(projectPath), access(touchCommandsPath), access(patchPath)]);
const wdaVersion = (JSON.parse(await readFile(path.join(wdaRoot, 'package.json'), 'utf8')) as { version?: string }).version;
if ((await readFile(touchCommandsPath, 'utf8')).includes('/wda/absolute-actions')) {
    console.log('WDA absolute-touch / Photos-import / sessionless-button patch is already applied');
} else {
    // Dry-run first: a patch that only fits with offsets or fuzz lands in the
    // wrong place and the WDA build fails, so refuse instead of half-applying.
    const dryRun = spawnSync('/usr/bin/patch', ['-p1', '-N', '--dry-run', '-d', wdaRoot, '-i', patchPath], { encoding: 'utf8' });
    if (dryRun.status !== 0 || /offset|fuzz/i.test(dryRun.stdout)) {
        throw new Error(`Patches/wda-16.1.1-farm.patch does not fit WDA ${wdaVersion} (tested on ${TESTED_WDA_VERSION}). `
            + `Re-run \`npm run setup\` to reinstall the pinned driver.\n${dryRun.stdout}${dryRun.stderr}`);
    }
    await run('/usr/bin/patch', ['-p1', '-N', '-d', wdaRoot, '-i', patchPath]);
    console.log(`Applied the WDA patch to WebDriverAgent ${wdaVersion}`);
}

const developerDir = resolveDeveloperDir();
const teamId = required('XCODE_ORG_ID');
const bundleId = required('WDA_BUNDLE_ID');

// `--udid <udid>`, or `--all` for every registered device, or the sole
// registered / connected device, or IOS_UDID. Xcode needs a concrete device
// for a signed device build.
const targets = await resolveBuildTargets();

for (const udid of targets) {
    if (targets.length > 1) console.log(`\n=== WebDriverAgent build for ${udid} ===`);
    await run('xcodebuild', [
        'build-for-testing',
        '-allowProvisioningUpdates',
        ...(process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true'
            ? ['-allowProvisioningDeviceRegistration']
            : []),
        '-project', projectPath,
        '-scheme', 'WebDriverAgentRunner',
        '-destination', `id=${udid}`,
        `IPHONEOS_DEPLOYMENT_TARGET=${process.env.IOS_PLATFORM_VERSION ?? '16.7'}`,
        `DEVELOPMENT_TEAM=${teamId}`,
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        `CODE_SIGN_IDENTITY=${process.env.XCODE_SIGNING_ID ?? 'Apple Development'}`,
        'CODE_SIGN_STYLE=Automatic',
        'GCC_TREAT_WARNINGS_AS_ERRORS=0',
        'COMPILER_INDEX_STORE_ENABLE=NO',
    ], { env: { ...process.env, DEVELOPER_DIR: developerDir } });
}
