// fixed-node-debug-cli.ts - Fixed Node.js implementation with proper connection handling
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbPacketDispatcher, AdbSocket } from "@yume-chan/adb";
import { TCPConfig, DebugManager, DebugSession } from './debug-manager';
import {ReadableStreamDefaultReader, WritableStreamDefaultWriter} from "@yume-chan/stream-extra";
import * as readline from 'readline';
import chalk from "chalk";

// Import your JDWP modules
import { JDWPClient } from './client';
import { JDWPTransport } from './protocol';

class NodeTcpJDWPTransport implements JDWPTransport {
    private socket: AdbSocket | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private packetCallback: ((packet: Uint8Array) => void) | null = null;
    private connected: boolean = false;
    private pendingData: Uint8Array = new Uint8Array(0);

    constructor(
        private serverClient: AdbServerClient,
        private deviceSerial: string,
        private pid: number
    ) {}

    async connect(): Promise<void> {
        try {
            console.log(chalk.gray(`Creating transport for device ${this.deviceSerial}...`));

            // Create transport for the specific device
            // set deviceSelector to undefined in order to match host:tport:any
            const deviceSelector = undefined;
            const transport = await this.serverClient.createTransport(deviceSelector);

            // Connect to JDWP service - THIS is where we provide the service string
            const socket = await transport.connect(`jdwp:${this.pid}`);

            this.socket = socket;
            this.reader = socket.readable.getReader();
            this.writer = socket.writable.getWriter();
            this.connected = true;

            // Start reading loop
            this.readLoop().catch(error => {
                console.error('JDWP read loop error:', error);
                this.handleDisconnect();
            });

            console.log(chalk.green(`Connected to JDWP service for PID ${this.pid}`));
        } catch (error) {
            throw new Error(`Failed to connect to JDWP service for PID ${this.pid}: ${error}`);
        }
    }

    async disconnect(): Promise<void> {
        this.connected = false;

        if (this.reader) {
            try {
                await this.reader.cancel();
            } catch (error) {
                // Ignore cancellation errors
            }
            this.reader = null;
        }

        if (this.writer) {
            try {
                await this.writer.close();
            } catch (error) {
                // Ignore close errors
            }
            this.writer = null;
        }

        if (this.socket) {
            try {
                await this.socket.close();
            } catch (error) {
                // Ignore close errors
            }
            this.socket = null;
        }

        this.packetCallback = null;
        this.pendingData = new Uint8Array(0);
    }

    async sendPacket(packet: Uint8Array): Promise<void> {
        if (!this.writer || !this.connected) {
            throw new Error('JDWP transport is not connected');
        }

        try {
            await this.writer.write(packet);
        } catch (error) {
            throw new Error(`Failed to send JDWP packet: ${error}`);
        }
    }

    onPacket(callback: (packet: Uint8Array) => void): void {
        this.packetCallback = callback;
    }

    isConnected(): boolean {
        return this.connected;
    }

    private async readLoop(): Promise<void> {
        if (!this.reader) return;

        try {
            while (this.connected) {
                const { value, done } = await this.reader.read();

                if (done) {
                    this.handleDisconnect();
                    break;
                }

                if (value && this.packetCallback) {
                    // Append new data to pending buffer
                    const newData = new Uint8Array(this.pendingData.length + value.length);
                    newData.set(this.pendingData, 0);
                    newData.set(value, this.pendingData.length);
                    this.pendingData = newData;

                    // Process complete JDWP packets
                    await this.processJdwpPackets();
                }
            }
        } catch (error) {
            if (this.connected) {
                console.error('Error in JDWP read loop:', error);
            }
            this.handleDisconnect();
        }
    }

    private async processJdwpPackets(): Promise<void> {
        while (this.pendingData.length >= 11) { // Minimum JDWP packet size
            // Read packet length (first 4 bytes, big-endian)
            const length = this.readUint32BE(this.pendingData, 0);

            // Validate packet length
            if (length < 11) {
                console.error('Invalid JDWP packet length:', length);
                this.pendingData = new Uint8Array(0);
                break;
            }

            // Check if we have a complete packet
            if (this.pendingData.length < length) {
                break; // Wait for more data
            }

            // Extract the complete packet
            const packetData = this.pendingData.slice(0, length);

            // Remove processed data from buffer
            this.pendingData = this.pendingData.slice(length);

            // Notify callback
            if (this.packetCallback) {
                try {
                    this.packetCallback(packetData);
                } catch (error) {
                    console.error('Error in packet callback:', error);
                }
            }
        }
    }

    private handleDisconnect(): void {
        this.connected = false;
        console.log('JDWP transport disconnected');
    }

    private readUint32BE(data: Uint8Array, offset: number): number {
        return (data[offset] << 24) |
               (data[offset + 1] << 16) |
               (data[offset + 2] << 8) |
               data[offset + 3];
    }
}


class JDWPCli {
    private serverClient: AdbServerClient | null = null;
    private deviceSerial: string | null = null;
    private debugManager: DebugManager | null = null;
    private currentSession: any = null;
    private rl: readline.Interface;

    constructor() {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: chalk.cyan('jdwp> ')
        });
    }

    async start() {
        console.log(chalk.green.bold('\n🔍 JDWP Debugger\n'));

        await this.connectToAdbServer();

        this.rl.prompt();

        this.rl.on('line', async (line) => {
            const input = line.trim();
            if (!input) {
                this.rl.prompt();
                return;
            }

            await this.handleCommand(input);
            this.rl.prompt();
        });

        this.rl.on('close', () => {
            console.log(chalk.yellow('\nGoodbye!'));
            process.exit(0);
        });
    }

    private async connectToAdbServer() {
        try {
            const connector = new AdbServerNodeTcpConnector({
                host: '127.0.0.1',
                port: 5037
            });

            this.serverClient = new AdbServerClient(connector);
            const devices = await this.serverClient.getDevices();

            if (devices.length === 0) {
                console.log(chalk.yellow('No devices connected'));
                return;
            }

            this.deviceSerial = devices[0].serial;

            // Create debug manager using DebugManager with TCP config
            const tcpConfig: TCPConfig = {
              serverClient: this.serverClient,
              deviceSerial: this.deviceSerial,
              type: 'tcp',
            };
            this.debugManager = new DebugManager(tcpConfig);


            console.log(chalk.green(`✅ Connected to device: ${this.deviceSerial}`));

            // Setup event listeners
            this.setupEventListeners();

        } catch (error: any) {
            console.log(chalk.red(`Failed to connect: ${error.message}`));
        }
    }

    private setupEventListeners() {
        if (!this.debugManager) return;

        this.debugManager.on('breakpointHit', (data: any) => {
            console.log(chalk.red.bold('\n🔴 BREAKPOINT HIT!'));
            console.log(chalk.white(`   Thread: ${data.threadId}`));
            console.log(chalk.white(`   ${data.breakpoint.className}.${data.breakpoint.methodName}`));
            this.currentSession = data.session;
            this.rl.prompt();
        });
    }

    private async handleCommand(input: string) {
        const [command, ...args] = input.split(' ');

        try {
            switch (command) {
                case 'list':
                    await this.listDebuggable();
                    break;

                case 'debug':
                    await this.startDebug(args[0]);
                    break;

                case 'stop':
                    await this.stopDebug();
                    break;

                case 'c':
                case 'continue':
                    await this.resume();
                    break;

                case 'help':
                    this.showHelp();
                    break;

                case 'exit':
                case 'quit':
                    if (this.currentSession) {
                        await this.stopDebug();
                    }
                    this.rl.close();
                    break;

                default:
                    console.log(chalk.red(`Unknown command: ${command}`));
            }
        } catch (error: any) {
            console.log(chalk.red(`Error: ${error.message}`));
        }
    }

    private async listDebuggable() {
        if (!this.serverClient || !this.deviceSerial) {
            console.log(chalk.red('Not connected'));
            return;
        }

        const pids = await this.debugManager?.getDebuggablePids()!;

        if (pids.length === 0) {
            console.log(chalk.yellow('No debuggable apps found'));
        } else {
            console.log(chalk.cyan(`Debuggable PIDs: ${pids.join(', ')}`));
        }
    }

    private async startDebug(packageName: string) {
        if (!packageName) {
            console.log(chalk.red('Usage: debug <package_name>'));
            return;
        }

        if (!this.debugManager) {
            console.log(chalk.red('Not connected'));
            return;
        }

        console.log(chalk.gray(`Starting debug session for ${packageName}...`));

        this.currentSession = await this.debugManager.startDebugging(packageName);

        console.log(chalk.green(`Debug session started (PID: ${this.currentSession.pid})`));

        // Set default breakpoint on MainActivity.onCreate
        const className = `L${packageName.replace(/\./g, '/')}/MainActivity;`;
        await this.debugManager.setBreakpoint(
            this.currentSession.pid,
            className,
            'onCreate'
        );

        console.log(chalk.gray(`Breakpoint set at ${className}.onCreate`));
    }

    private async stopDebug() {
        if (!this.currentSession || !this.debugManager) {
            console.log(chalk.yellow('No active session'));
            return;
        }

        await this.debugManager.stopDebugging(this.currentSession.pid);
        this.currentSession = null;
        console.log(chalk.green('Debug session stopped'));
    }

    private async resume() {
        if (!this.currentSession || !this.debugManager) {
            console.log(chalk.yellow('No active session'));
            return;
        }

        if (this.currentSession.currentThread) {
            await this.debugManager.resumeThread(
                this.currentSession.pid,
                this.currentSession.currentThread
            );
            console.log(chalk.green('Resumed'));
        } else {
            console.log(chalk.yellow('No suspended thread'));
        }
    }

    private showHelp() {
        console.log(chalk.cyan('\nCommands:'));
        console.log('  list              - List debuggable PIDs');
        console.log('  debug <package>   - Start debugging');
        console.log('  stop              - Stop debugging');
        console.log('  c, continue       - Resume execution');
        console.log('  help              - Show this help');
        console.log('  exit              - Exit\n');
    }
}

// Main
async function main() {
    const cli = new JDWPCli();
    await cli.start();
}

if (require.main === module) {
    main().catch(console.error);
}

export { JDWPCli, NodeTcpJDWPTransport };
