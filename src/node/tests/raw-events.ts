import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { DebugManager, TCPConfig } from '../../debug-manager';
import { NodeTcpJDWPTransport } from "../node-debug-cli";
import chalk = require("chalk");

async function testRawEvents(packageName: string) {
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

        // Wait for app PID
        console.log(chalk.gray('Waiting for app...'));
        const appPid = await debugManager.findAppPid(packageName);
        console.log(chalk.green(`App started (PID: ${appPid})`));

        // Create raw transport
        console.log(chalk.gray('Connecting JDWP...'));
        const jdwpTransport = new NodeTcpJDWPTransport(serverClient, deviceSerial, appPid);

        let packetCount = 0;
        let eventPacketCount = 0;
        const originalOnPacket = jdwpTransport.onPacket.bind(jdwpTransport);
        jdwpTransport.onPacket = (callback) => {
            originalOnPacket((packet: Uint8Array) => {
                packetCount++;

                // Check if this is an event packet (command set 64, command 100)
                if (packet.length >= 11) {
                    const flags = packet[8];
                    const commandSet = packet[9];
                    const command = packet[10];

                    console.log(chalk.gray(`[PACKET ${packetCount}] Flags: ${flags}, CS: ${commandSet}, Cmd: ${command}, Len: ${packet.length}`));

                    if (commandSet === 64 && command === 100) {
                        eventPacketCount++;
                        console.log(chalk.yellow(`  → EVENT PACKET! (#${eventPacketCount})`));

                        // Try to parse event type
                        if (packet.length > 11) {
                            const suspendPolicy = packet[11];
                            const eventCount = (packet[12] << 24) | (packet[13] << 16) | (packet[14] << 8) | packet[15];
                            const eventKind = packet[16];
                            console.log(chalk.yellow(`    Suspend: ${suspendPolicy}, Events: ${eventCount}, Kind: ${eventKind}`));
                        }
                    }
                }

                callback(packet);
            });
        };
        await jdwpTransport.connect();
        console.log(chalk.green('Transport connected'));
        // Send raw commands to set up events
        console.log(chalk.yellow('\n📍 Setting up VM_DEATH event (should always work)...'));

        const vmDeathData = new Uint8Array([
            0, 0, 0, 17,  // Length: 17 bytes
            0, 0, 0, 1,   // ID: 1
            0,            // Flags: command
            15,           // Command Set: EventRequest
            1,            // Command: Set
            99,           // Event kind: VM_DEATH
            0,            // Suspend policy: NONE
            0, 0, 0, 0    // Modifiers count: 0
        ]);

        await jdwpTransport.sendPacket(vmDeathData);
        console.log(chalk.green('VM_DEATH event request sent'));

        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log(chalk.yellow('\n📍 Setting up THREAD_START event...'));

        const threadStartData = new Uint8Array([
            0, 0, 0, 17,  // Length: 17 bytes
            0, 0, 0, 2,   // ID: 2
            0,            // Flags: command
            15,           // Command Set: EventRequest
            1,            // Command: Set
            6,            // Event kind: THREAD_START
            0,            // Suspend policy: NONE
            0, 0, 0, 0    // Modifiers count: 0
        ]);

        await jdwpTransport.sendPacket(threadStartData);
        console.log(chalk.green('THREAD_START event request sent'));

        // Wait for response
        await new Promise(resolve => setTimeout(resolve, 100));

        console.log(chalk.yellow('\n📍 Setting up CLASS_PREPARE event...'));

        const classPrepareData = new Uint8Array([
            0, 0, 0, 17,  // Length: 17 bytes
            0, 0, 0, 3,   // ID: 3
            0,            // Flags: command
            15,           // Command Set: EventRequest
            1,            // Command: Set
            8,            // Event kind: CLASS_PREPARE
            0,            // Suspend policy: NONE
            0, 0, 0, 0    // Modifiers count: 0
        ]);

        await jdwpTransport.sendPacket(classPrepareData);
        console.log(chalk.green('CLASS_PREPARE event request sent'));

        // Force some activity
        console.log(chalk.yellow('\n📍 Forcing thread list (might trigger events)...'));

        const threadListData = new Uint8Array([
            0, 0, 0, 11,  // Length: 11 bytes
            0, 0, 0, 4,   // ID: 4
            0,            // Flags: command
            1,            // Command Set: VirtualMachine
            4             // Command: AllThreads
        ]);

        await jdwpTransport.sendPacket(threadListData);
        console.log(chalk.green('Thread list requested'));

        // Monitor
        console.log(chalk.cyan('\n⏱️ Monitoring for 30 seconds...'));
        console.log(chalk.gray('Interact with the app to trigger events\n'));

        await new Promise(resolve => setTimeout(resolve, 30000));

        console.log(chalk.cyan(`\n📊 Results:`));
        console.log(`  Total packets received: ${packetCount}`);
        console.log(`  Event packets received: ${eventPacketCount}`);

        if (eventPacketCount === 0) {
            console.log(chalk.red('\n❌ No event packets received!'));
            console.log(chalk.yellow('This means events are not being sent by JDWP'));
        } else {
            console.log(chalk.green('\n✅ Events are being received!'));
            console.log(chalk.yellow('The issue is in event parsing/dispatching'));
        }

        await jdwpTransport.disconnect();
    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
    }

    process.exit(0);
}

// Main
const packageName = process.argv[2] || 'tech.httptoolkit.pinning_demo';
testRawEvents(packageName).catch(console.error);
