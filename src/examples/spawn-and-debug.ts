import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { DebugManager, TCPConfig } from './debug-manager';
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
        const debugManager = new DebugManager(tcpConfig);

        // Spawn app in debug mode
        console.log(chalk.gray('Starting app in debug mode...'));
        await debugManager.spawnAppDebug(packageName);

        // Wait for app PID
        console.log(chalk.gray('Waiting for app...'));
        const appPid = await debugManager.findAppPid(packageName);
        console.log(chalk.green(`App started (PID: ${appPid})`));

        // Generic event listener for ALL events
        debugManager.on('sessionStarted', () => {
            console.log(chalk.blue('[EVENT] Session started'));
        });

        debugManager.on('breakpointSet', (data: any) => {
            console.log(chalk.blue(`[EVENT] Breakpoint set: ${data.breakpoint.className}.${data.breakpoint.methodName}`));
        });
        // Setup breakpoint handler
        debugManager.on('breakpointHit', async (data: any) => {
            console.log(chalk.red.bold('\n🔴 Breakpoint hit!'));
            console.log(`Location: Activity.onCreate()`);
            console.log(`Thread: ${data.threadId}`);

            // Print local variables
            try {
                const frames = await debugManager.getStackFrames(data.session.pid, data.threadId);
                if (frames.length > 0) {
                    const locals = await debugManager.getLocalVariables(
                        data.session.pid,
                        data.threadId,
                        frames[0].frameId
                    );

                    console.log(chalk.cyan('\nLocal variables:'));
                    if (locals.length === 0) {
                        console.log('  (none)');
                    } else {
                        for (const v of locals) {
                            console.log(`  ${v.name}: ${JSON.stringify(v.value)}`);
                        }
                    }
                }
            } catch (error) {
                console.log('Could not get variables');
            }

            // Resume
            console.log(chalk.gray('\nResuming...'));
            await debugManager.resumeThread(data.session.pid, data.threadId);
        });

        debugManager.on('threadStarted', (data: any) => {
            console.log(chalk.gray(`[EVENT] Thread started: ${data.threadId}`));
        });

        debugManager.on('classPrepared', (data: any) => {
            console.log(chalk.gray(`[EVENT] Class prepared: ${data.signature}`));
        });

        // Start debug session
        console.log(chalk.yellow('\n📌 Connecting JDWP...'));
        const session = await debugManager.startDebugging(packageName, appPid);
        console.log(chalk.green(`JDWP debug session connected: ${appPid}`));

        // Set breakpoint on Activity.onCreate
        // await debugManager.setBreakpoint(
        //     session.pid,
        //     'Landroid/app/Activity;',
        //     'onCreate'
        // );
        // console.log(chalk.yellow('Breakpoint set on Activity.onCreate()'));

        const breakpointTargets = [
            { class: 'Landroid/app/Activity;', method: 'onCreate' },
            { class: `L${packageName.replace(/\./g, '/')}/MainActivity;`, method: 'onCreate' },
            { class: 'Landroid/app/Activity;', method: 'onStart' },
            { class: 'Landroid/app/Activity;', method: 'onResume' },
        ];

        console.log(chalk.yellow('\n📍 Setting breakpoints:'));
        const breakpointIds: number[] = [];

        for (const target of breakpointTargets) {
            try {
                const bp = await debugManager.setBreakpoint(
                    session.pid,
                    target.class,
                    target.method
                );
                breakpointIds.push(bp.requestId);
                console.log(chalk.green(`  ✅ ${target.class}.${target.method} (ID: ${bp.requestId})`));
            } catch (error: any) {
                console.log(chalk.red(`  ❌ ${target.class}.${target.method}: ${error.message}`));
            }
        }

        // List all event requests to verify breakpoints
        console.log(chalk.yellow('\n📋 Verifying breakpoints via JDWP:'));
        try {
            // Send EventRequest.ClearAllBreakpoints with dryRun to list them
            const listData = new Uint8Array(0);
            const response = await session.client.sendCommand(15, 4, listData); // EventRequest.RequestID
            console.log(chalk.gray(`  Raw response length: ${response.data.length} bytes`));
        } catch (error) {
            console.log(chalk.gray('  Could not list event requests'));
        }

        // Get threads
        console.log(chalk.yellow('\n🧵 Current threads:'));
        const threads = await debugManager.getThreads(session.pid);
        for (const thread of threads) {
            const status = thread.suspendCount > 0 ? '⏸️ SUSPENDED' : '▶️ RUNNING';
            console.log(`  [${thread.threadId}] ${thread.name} - ${status}`);
        }


        // Resume app (was started with -D flag)
        console.log(chalk.gray('Resuming app...'));
        // const threads = await debugManager.getThreads(session.pid);
        for (const thread of threads) {
            if (thread.suspendCount > 0) {
                await debugManager.resumeThread(session.pid, thread.threadId);
            }
        }

        console.log(chalk.green('App running. Press Ctrl+C to stop.\n'));

        // Wait for Ctrl+C
        await new Promise((resolve) => {
            process.on('SIGINT', async () => {
                console.log(chalk.yellow('\nStopping...'));
                await debugManager.stopDebugging(session.pid);
                resolve(undefined);
            });
        });

    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
    }

    process.exit(0);
}

// Main
const packageName = process.argv[2] || 'com.example.myapplication';
spawnAndDebug(packageName).catch(console.error);
