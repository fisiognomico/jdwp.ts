// example-debug-myapplication.ts - Example debugging com.example.myapplication
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { DebugManager, TCPConfig } from './debug-manager';
import chalk = require("chalk");

async function debugMyApplication() {
    console.log(chalk.cyan.bold('Debugging com.example.myapplication\n'));

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
        console.log(chalk.green(`Connected to: ${deviceSerial}`));

        // 2. Create debug manager
        const tcpConfig: TCPConfig = {
          type: 'tcp',
          deviceSerial: deviceSerial,
          serverClient: serverClient,
        }
        const debugManager = new DebugManager(tcpConfig);

        // 3. Setup breakpoint hit handler
        debugManager.on('breakpointHit', async (data: any) => {
            console.log(chalk.red.bold('\n🔴 Breakpoint hit in MainActivity.onCreate()'));
            console.log(`Thread ID: ${data.threadId}`);

            // Get local variables
            try {
                const frames = await debugManager.getStackFrames(data.session.pid, data.threadId);
                if (frames.length > 0) {
                    const locals = await debugManager.getLocalVariables(
                        data.session.pid,
                        data.threadId,
                        frames[0].frameId
                    );

                    console.log('\nLocal variables:');
                    for (const variable of locals) {
                        console.log(`  ${variable.name} = ${variable.value}`);
                    }
                }
            } catch (error) {
                console.log('Could not get variables');
            }

            // Resume after 2 seconds
            setTimeout(async () => {
                console.log('\nResuming execution...');
                await debugManager.resumeThread(data.session.pid, data.threadId);
            }, 2000);
        });

        // 4. Start debugging
        const session = await debugManager.startDebugging('com.example.myapplication');
        console.log(chalk.green(`Debug session started (PID: ${session.pid})`));

        // 5. Set breakpoint
        const breakpoint = await debugManager.setBreakpoint(
            session.pid,
            'Lcom/example/myapplication/MainActivity;',
            'onCreate'
        );
        console.log(chalk.yellow('Breakpoint set at MainActivity.onCreate()'));
        console.log('\nNow launch or restart the app to hit the breakpoint...\n');

        // Keep running until Ctrl+C
        await new Promise((resolve) => {
            process.on('SIGINT', async () => {
                console.log('\nStopping debug session...');
                await debugManager.stopDebugging(session.pid);
                resolve(undefined);
            });
        });

    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
    }

    process.exit(0);
}

// Run
if (require.main === module) {
    debugMyApplication().catch(console.error);
}
