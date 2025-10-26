import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { DebugManager, TCPConfig } from '../debug-manager';
import { JDWPEvent } from '../protocol';
import chalk = require("chalk");

async function spawnAndDebug(packageName: string) {
    console.log(chalk.cyan.bold(`\nSpawn & Debug: ${packageName}\n`));

    try {
        // Connect to ADB
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
        console.log(chalk.green(`Device: ${deviceSerial}`));

        // Create debug manager
        const tcpConfig: TCPConfig = {
          type: 'tcp',
          deviceSerial: deviceSerial,
          serverClient: serverClient,
        }
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
        // TODO here we can see why the idea of managing multiple PIDs per
        // debug session makes no sense
        //
        const debugSession = await debugManager.startDebugging(packageName, appPid);

        // Set breakpoint on Activity.onCreate()
        const activityClass = "Landroid/app/Activity;";
        const createMethod = "onCreate";
        const onCreateBP = await debugManager.setBreakpoint(appPid, activityClass, createMethod);
        // Resume VM Execution
        console.log(chalk.yellow('\nResuming VM...'));
        await debugManager.resume(appPid);
        console.log(chalk.green('✓ VM resumed'));

        // Register event handler
        console.log("Waiting for onCreate to be called");
        const breakpointPromise = new Promise<JDWPEvent>((resolve) => {
            debugManager.onEvent(appPid, onCreateBP, (event) => {
                console.log(chalk.red.bold(` 🔴 BREAKPOINT HIT! From ${event.signature}`));
                resolve(event);
            });
        });

        const event = await breakpointPromise;
        await debugManager.resume(appPid);

        // For a clean exit unset debugabble app
        const unDebug = `shell,v2,,raw:am clear-debug-app ${packageName}`;
        await debugManager.executeCommand(unDebug);

    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
    }

    process.exit(0);
}

// Main
const packageName = process.argv[2] || 'com.example.myapplication';
spawnAndDebug(packageName).catch(console.error);
