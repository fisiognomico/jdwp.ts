// check-read-loop.ts - Check if the transport read loop is actually running
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { NodeTcpJDWPTransport } from '../node-debug-cli';
import { JDWPClient } from '../client';
import { JDWPEventKind } from "../protocol";
import chalk = require("chalk");

async function checkReadLoop(packageName: string) {
    console.log(chalk.cyan.bold(`\n🔄 Read Loop Check\n`));

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
        // Find app PID
        console.log(chalk.gray('Finding app...'));
        const psTransport = await serverClient.createTransport(undefined);
        const psSocket = await psTransport.connect('shell,v2,,raw:ps');

        const psReader = psSocket.readable.getReader();
        let psOutput = '';
        while (true) {
            const { value, done } = await psReader.read();
            if (done) break;
            psOutput += new TextDecoder().decode(value);
        }
        await psSocket.close();

        let appPid: number | null = null;
        const lines = psOutput.split('\n');
        for (const line of lines) {
            if (line.includes(packageName)) {
                const match = line.match(/^\S+\s+(\d+)/);
                if (match) {
                    appPid = parseInt(match[1], 10);
                    break;
                }
            }
        }

        if (!appPid) {
            throw new Error(`App ${packageName} not running`);
        }

        console.log(chalk.green(`App PID: ${appPid}`));

        // CREATE ONE CONNECTION
        const transport = new NodeTcpJDWPTransport(serverClient, deviceSerial, appPid);
        const client = new JDWPClient(transport);

        // Track all events
        let eventCount = 0;
        client.onEvent(0, (event) => {
            eventCount++;
            console.log(chalk.yellow(`[EVENT ${eventCount}] Kind: ${event.eventKind}, Thread: ${event.threadId}, Request: ${event.requestId}`));
        });
        await client.connect();
        console.log(chalk.green('Client connected'));


        // Test that basic commands work
        console.log(chalk.gray('\nTesting basic commands...'));
        try {
            const response = await client.sendCommand(1, 4, new Uint8Array(0)); // AllThreads
            const threadCount = (response.data[0] << 24) | (response.data[1] << 16) |
                               (response.data[2] << 8) | response.data[3];
            console.log(chalk.green(`✅ AllThreads works: ${threadCount} threads`));
        } catch (error: any) {
            console.log(chalk.red(`❌ AllThreads failed: ${error.message}`));
        }

        // 1. VM_DEATH event (should always work)
        try {
            const vmDeathReqId = await client.setupEvent(JDWPEventKind.VM_DEATH, 0);
            client.onEvent(vmDeathReqId, (event) => {
                console.log('VM_DEATH event!');
                eventCount++;
            });
            console.log(chalk.green(`  ✅ VM_DEATH event set (ID: ${vmDeathReqId})`));
        } catch (error: any) {
            console.log(chalk.red(`  ❌ VM_DEATH failed: ${error.message}`));
        }


        // 2. THREAD_START event
        try {
            const threadStartReqId = await client.setupEvent(JDWPEventKind.THREAD_START, 0);
            client.onEvent(threadStartReqId, (event) => {
                console.log(`THREAD ${event.threadId} started!`);
                eventCount++;
            });
            console.log(chalk.green(`  ✅ THREAD_START event set (ID: ${threadStartReqId})`));
        } catch (error: any) {
            console.log(chalk.red(`  ❌ THREAD_START failed: ${error.message}`));
        }

        // 3. CLASS_PREPARE event
        try {
            const classPrepareReqId = await client.setupEvent(JDWPEventKind.CLASS_PREPARE, 0);
            client.onEvent(classPrepareReqId, (event) => {
                console.log(`Class Prepare: ${event.signature}`);
                eventCount++;
            });
            console.log(chalk.green(`  ✅ CLASS_PREPARE event set (ID: ${classPrepareReqId})`));
        } catch (error: any) {
            console.log(chalk.red(`  ❌ CLASS_PREPARE failed: ${error.message}`));
        }

        // 4. Try a simple breakpoint
        console.log(chalk.yellow('\n📍 Setting breakpoint...'));
        try {
            // First, check if Activity class exists
            const classSig = 'Landroid/app/Activity;';
            const requestId = await client.setBreakpointAtMethodEntry(classSig, 'onCreate');
            console.log(chalk.green(`  ✅ Breakpoint set on Activity.onCreate (ID: ${requestId})`));

            client.onEvent(requestId, (event) => {
                console.log(chalk.red.bold(`  🔴 BREAKPOINT HIT! Thread: ${event.threadId}`));
                eventCount++;
            });
        } catch (error: any) {
            console.log(chalk.red(`  ❌ Breakpoint failed: ${error.message}`));
        }

        // Force some activity
        console.log(chalk.yellow('\n📍 Forcing activity...'));

        const activityTransport = await serverClient.createTransport(undefined);
        // Start a new activity to trigger class loads
        const activitySocket = await activityTransport.connect(
            `shell,v2,,raw:am start -S -W -n ${packageName}/.MainActivity`
        );
        await activitySocket.close();
        console.log(chalk.green('  Restarted MainActivity'));

        // Monitor for events
        console.log(chalk.cyan('\n⏱️ Monitoring for 30 seconds...'));
        console.log(chalk.gray('Try interacting with the app (press back, home, etc.)\n'));

        let lastEventCount = 0;
        const interval = setInterval(() => {
            if (eventCount > lastEventCount) {
                console.log(chalk.green(`  Events increased: ${lastEventCount} → ${eventCount}`));
                lastEventCount = eventCount;
            }
        }, 1000);

        await new Promise(resolve => setTimeout(resolve, 30000));
        clearInterval(interval);

        console.log(chalk.cyan(`\n📊 Results:`));
        console.log(`  Total events received: ${eventCount}`);

        if (eventCount === 0) {
            console.log(chalk.red('\n❌ No events received!'));
            console.log(chalk.yellow('Possible issues:'));
            console.log('  1. Event parsing is broken');
            console.log('  2. App not generating events');
            console.log('  3. Event dispatch not working');
        } else {
            console.log(chalk.green('\n✅ Events are working!'));
        }


        await client.disconnect();
    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
        console.log(error.stack);
    }

    process.exit(0);
}

// Main
const packageName = process.argv[2] || 'tech.httptoolkit.pinning_demo';
checkReadLoop(packageName).catch(console.error);
