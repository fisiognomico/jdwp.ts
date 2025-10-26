import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { DebugManager, TCPConfig } from "../debug-manager";

import chalk from 'chalk';

/*
 * Minimal example showing how to execute commands using the JDWP Library
 */

async function demonstrateruntimeExecution(targetApp: string) {
    console.log(chalk.cyan.bold('🔧 JDWP Runtime Execution Demo\n'));

    try {
       // 1. Connect to ADB server
        const connector = new AdbServerNodeTcpConnector({
            host: '127.0.0.1',
            port: 5037
        });

        const serverClient = new AdbServerClient(connector);
        const devices = await serverClient.getDevices();

        if (devices.length === 0) {
            throw new Error('No device connected');
        }

        const deviceSerial = devices[0].serial;
        console.log(chalk.green(`✅ Connected to: ${deviceSerial}\n`));

        // 2. Create debug manager
        const tcpConfig: TCPConfig = {
            type: 'tcp',
            serverClient: serverClient,
            deviceSerial: deviceSerial,
        };
        const debugManager = new DebugManager<TCPConfig>(tcpConfig);

        // Spawn app in debug mode
        console.log(chalk.gray('Starting app in debug mode...'));
        const setPackageDebugMode = `shell,v2,,raw:am set-debug-app -w ${packageName}`;
        await debugManager.executeCommand(setPackageDebugMode);

        // Find MainActivity
        const findMainActivity = `shell,v2,,raw:cmd package resolve-activity --brief ${packageName}`;
        const lines = await debugManager.executeCommand(findMainActivity);
        const unlastLine = lines[(lines.length - 1)].split(/\r?\n/);
        const lastLine = unlastLine[1].trim();
        let mainActivity = "";
        if(lastLine.includes('/')) {
            mainActivity = lastLine.trim();
        } else {
            // Switch to default name
            console.warn(`[+] Issue with cmd parsing ${lines}`);
            mainActivity = `${packageName}/.MainActivity`;
        }
        console.log(`MainActivity: ${mainActivity}`);

        // Start app and wait for the debugger
        console.log(chalk.gray('Starting app (will wait for debugger)...'));
        const spawnActivity = `shell,v2,,raw:am start -n ${mainActivity}`;
        await debugManager.executeCommand(spawnActivity);

        // Small delay to ensure app is started
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Wait for app PID
        console.log(chalk.gray('Waiting for app...'));
        const appPid = await debugManager.findAppPid(packageName);
        console.log(chalk.green(`App started (PID: ${appPid})`));
        // Start debug session
        const debugSession = await debugManager.startDebugging(packageName, appPid);

        // Set breakpoint on Activity.onCreate()
        const activityClass = "Landroid/app/Activity;";
        const createMethod = "onCreate";
        const {requestId, threadId} = await debugSession.client.setBreakpointAndWait(
            activityClass,
            createMethod
        );
        console.log(chalk.green(`✅ Breakpoint hit! Thread ${threadId} is suspended\n`));

        // 2. Now we have a SUSPENDED thread - use it for everything
        console.log(chalk.yellow('=== Executing Commands on Suspended Thread ===\n'));
        try {
            // Example 1: List files in app's data directory
            console.log(chalk.gray('Listing app data directory...'));
            const exitCode1 = await debugManager.executeJDWP(
                appPid,
                'ls -la /data/data/' + targetApp
            );
            console.log(chalk.green(`✅ ls command exit code: ${exitCode1}\n`));

            // Example 2: Get system properties
            console.log(chalk.gray('Getting system properties...'));
            const exitCode2 = await debugManager.executeJDWP(
                appPid,
                'getprop ro.build.version.sdk'
            );
            console.log(chalk.green(`✅ getprop exit code: ${exitCode2}\n`));

            // Example 3: Create a file in app's directory (if permissions allow)
            console.log(chalk.gray('Creating test file...'));
            const exitCode3 = await debugManager.executeJDWP(
                appPid,
                `touch /data/data/${targetApp}/test_jdwp.txt`
            );
            console.log(chalk.green(`✅ touch command exit code: ${exitCode3}\n`));
        } finally {
            console.log(chalk.yellow('\n=== Resuming Thread ==='));
            await debugSession.client.resumeThread(threadId);
            console.log(chalk.green('✅ Thread resumed, app continues\n'));
        }

    } catch (error: any) {
        console.log(chalk.red(`❌ Error: ${error.message}`));
    }

    process.exit(0);
}
const packageName = process.argv[2] || 'tech.httptoolkit.pinning_demo';
demonstrateruntimeExecution(packageName).catch(console.error);
