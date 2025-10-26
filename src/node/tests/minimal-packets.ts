import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import chalk = require("chalk");

async function minimalPacketTest(packageName: string) {
    console.log(chalk.cyan.bold(`\n🔬 Minimal Packet Test\n`));

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

        // Connect directly to JDWP
        console.log(chalk.gray('\nConnecting to JDWP...'));
        const transport = await serverClient.createTransport(undefined);
        const socket = await transport.connect(`jdwp:${appPid}`);

        console.log(chalk.green('Socket connected'));

        // Send handshake
        console.log(chalk.gray('Sending handshake...'));
        const writer = socket.writable.getWriter();
        const handshake = new TextEncoder().encode('JDWP-Handshake');
        await writer.write(handshake);

        // Read handshake response
        console.log(chalk.gray('Reading handshake response...'));
        const reader = socket.readable.getReader();

        const handshakeResponse = new Uint8Array(14);
        let offset = 0;

        while (offset < 14) {
            const { value, done } = await reader.read();
            if (done) {
                console.log(chalk.red('Connection closed during handshake'));
                break;
            }

            const toCopy = Math.min(14 - offset, value!.length);
            handshakeResponse.set(value!.slice(0, toCopy), offset);
            offset += toCopy;

            console.log(chalk.gray(`Read ${value!.length} bytes`));
        }

        const responseStr = new TextDecoder().decode(handshakeResponse);
        console.log(chalk.green(`Handshake response: "${responseStr}"`));

        if (responseStr !== 'JDWP-Handshake') {
            throw new Error('Invalid handshake');
        }

        // Now send a simple command and wait for response
        console.log(chalk.yellow('\n📍 Sending Version command...'));

        const versionCmd = new Uint8Array([
            0, 0, 0, 11,  // Length: 11 bytes
            0, 0, 0, 1,   // ID: 1
            0,            // Flags: command
            1,            // Command Set: VirtualMachine
            1             // Command: Version
        ]);

        await writer.write(versionCmd);
        console.log(chalk.green('Version command sent'));

        // Read response
        console.log(chalk.gray('Waiting for response...'));

        // Read response header (11 bytes)
        const responseHeader = new Uint8Array(11);
        let responseBody: Uint8Array | null = null;
        let excessData: Uint8Array | null = null;
        offset = 0;

        while (offset < 11) {
            const { value, done } = await reader.read();
            if (done) {
                console.log(chalk.red('Connection closed while reading response'));
                break;
            }

            const toCopy = Math.min(11 - offset, value!.length);
            responseHeader.set(value!.slice(0, toCopy), offset);

            // Save any excess data for future parsing
            if(value!.length > toCopy) {
                excessData = value!.slice(toCopy);
                console.log(chalk.yellow(`Saved ${excessData.length} excess bytes`));
            }

            offset += toCopy;
            console.log(chalk.gray(`Read ${value!.length} bytes for header`));
        }

        const respLength = (responseHeader[0] << 24) | (responseHeader[1] << 16) |
                          (responseHeader[2] << 8) | responseHeader[3];
        const bodyLength = respLength - 11;
        const respId = (responseHeader[4] << 24) | (responseHeader[5] << 16) |
                       (responseHeader[6] << 8) | responseHeader[7];
        const respFlags = responseHeader[8];

        console.log(chalk.green(`Response: Length=${respLength}, ID=${respId}, Flags=${respFlags}`));

        // Read response body if any
        if (bodyLength > 0) {
            const responseBody = new Uint8Array(bodyLength);
            offset = 0;
            // First use any excess data
            if (excessData) {
                const toCopy = Math.min(bodyLength, excessData.length);
                responseBody.set(excessData.slice(0, toCopy), 0);
                offset = toCopy;
                console.log(chalk.gray(`Used ${toCopy} bytes from excess data`));
            }

            while (offset < bodyLength) {
                const { value, done } = await reader.read();
                if (done) break;

                const toCopy = Math.min(bodyLength - offset, value!.length);
                responseBody.set(value!.slice(0, toCopy), offset);
                offset += toCopy;
            }

            console.log(chalk.green(`Body: ${responseBody.length} bytes`));

            // Try to parse version info
            if (responseBody.length >= 10) {
                let off = 2; // Skip error code

                // Description string
                const descLen = (responseBody[off] << 24) | (responseBody[off+1] << 16) |
                               (responseBody[off+2] << 8) | responseBody[off+3];
                off += 4;
                const desc = new TextDecoder().decode(responseBody.slice(off, off + descLen));
                console.log(chalk.cyan(`JVM Version: ${desc}`));
            }
        }

        // Now set up an event and monitor
        console.log(chalk.yellow('\n📍 Setting up VM_DEATH event...'));

        const vmDeathCmd = new Uint8Array([
            0, 0, 0, 17,  // Length: 17 bytes
            0, 0, 0, 2,   // ID: 2
            0,            // Flags: command
            15,           // Command Set: EventRequest
            1,            // Command: Set
            99,           // Event kind: VM_DEATH
            0,            // Suspend policy: NONE
            0, 0, 0, 0    // Modifiers count: 0
        ]);

        await writer.write(vmDeathCmd);
        console.log(chalk.green('VM_DEATH event command sent'));

        // Monitor for any packets
        console.log(chalk.cyan('\n⏱️ Monitoring for 20 seconds...'));
        console.log(chalk.gray('Any received packets will be shown:\n'));

        let packetCount = 0;
        const startTime = Date.now();

        while (Date.now() - startTime < 20000) {
            // Try to read with timeout
            const readPromise = reader.read();
            const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 1000));

            const result: any = await Promise.race([readPromise, timeoutPromise]);

            if (result.timeout) {
                // Timeout, continue
                continue;
            }

            if (result.done) {
                console.log(chalk.red('Connection closed'));
                break;
            }

            if (result.value && result.value.length > 0) {
                packetCount++;
                console.log(chalk.yellow(`[PACKET ${packetCount}] ${result.value.length} bytes received`));

                // Try to parse as JDWP packet
                if (result.value.length >= 11) {
                    const len = (result.value[0] << 24) | (result.value[1] << 16) |
                               (result.value[2] << 8) | result.value[3];
                    const id = (result.value[4] << 24) | (result.value[5] << 16) |
                              (result.value[6] << 8) | result.value[7];
                    const flags = result.value[8];
                    const cs = result.value[9];
                    const cmd = result.value[10];

                    console.log(chalk.gray(`  Length: ${len}, ID: ${id}, Flags: ${flags}, CS: ${cs}, Cmd: ${cmd}`));

                    if (cs === 64 && cmd === 100) {
                        console.log(chalk.green(`  → This is an EVENT packet!`));
                    }
                }
            }
        }

        console.log(chalk.cyan(`\n📊 Results:`));
        console.log(`  Packets received: ${packetCount}`);

        // Clean close
        await writer.close();
        await reader.cancel();
        await socket.close();

    } catch (error: any) {
        console.log(chalk.red(`Error: ${error.message}`));
        console.log(error.stack);
    }

    process.exit(0);
}

// Main
const packageName = process.argv[2] || 'tech.httptoolkit.pinning_demo';
minimalPacketTest(packageName).catch(console.error);
