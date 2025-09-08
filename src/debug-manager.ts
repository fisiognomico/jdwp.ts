// debug-manager.ts - High-level debugging manager
import { JDWPClient } from './client';
import { AdbJDWPTransport } from './adb-transport';
import { Adb, AdbDaemonConnection } from "@yume-chan/adb";
import { JDWPEvent, JDWPEventKind } from './protocol';
import { adbRun} from './lib';

export class DebugManager {
    private jdwpClient: JDWPClient | null = null;
    private breakpointRequestIds: Set<number> = new Set();

    constructor(private connection: AdbDaemonConnection, private adb: Adb) {}

    async startDebugging(pid: number): Promise<void> {
        try {
            const transport = new AdbJDWPTransport(this.connection, pid);
            this.jdwpClient = new JDWPClient(transport);

            await this.jdwpClient.connect();
            console.log('JDWP debugging session started');
        } catch (error) {
            throw new Error(`Failed to start debugging session: ${error}`);
        }
    }

    async stopDebugging(): Promise<void> {
        if (this.jdwpClient) {
            // Clear all breakpoints
            for (const requestId of this.breakpointRequestIds) {
                try {
                    await this.jdwpClient.sendCommand(15, 2, this.createEventRequestClearPacket(requestId)); // EventRequest.Clear
                } catch (error) {
                    console.warn(`Failed to clear breakpoint ${requestId}:`, error);
                }
            }
            this.breakpointRequestIds.clear();

            await this.jdwpClient.disconnect();
            this.jdwpClient = null;
        }
    }

    async setBreakpointAtMethodEntry(classSignature: string, methodName: string): Promise<number> {
        if (!this.jdwpClient) {
            throw new Error('JDWP client is not connected');
        }

        try {
            const requestId = await this.jdwpClient.setBreakpointAtMethodEntry(classSignature, methodName);
            this.breakpointRequestIds.add(requestId);

            // Register event handler
            this.jdwpClient.onEvent(requestId, (event: JDWPEvent) => {
                if (event.eventKind === JDWPEventKind.BREAKPOINT) {
                    console.log(`Breakpoint hit at thread ${event.threadId}`);
                    this.onBreakpointHit(event);
                }
            });

            return requestId;
        } catch (error) {
            throw new Error(`Failed to set breakpoint at ${classSignature}.${methodName}: ${error}`);
        }
    }

    async waitForBreakpoint(timeoutMs: number = 30000): Promise<JDWPEvent> {
        if (!this.jdwpClient) {
            throw new Error('JDWP client is not connected');
        }

        return new Promise<JDWPEvent>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for breakpoint'));
            }, timeoutMs);

            // This is a simplified implementation
            // A real implementation would track breakpoint events more precisely
            const handler = (event: JDWPEvent) => {
                if (event.eventKind === JDWPEventKind.BREAKPOINT) {
                    clearTimeout(timeout);
                    resolve(event);
                }
            };

            // Add temporary event handler
            // Note: This is a simplified approach - a real implementation would
            // need to manage multiple breakpoints more carefully
            this.jdwpClient!.onEvent(0, handler);
        });
    }

    async resumeThread(threadId: number): Promise<void> {
        if (!this.jdwpClient) {
            throw new Error('JDWP client is not connected');
        }

        try {
            await this.jdwpClient.resumeThread(threadId);
        } catch (error) {
            throw new Error(`Failed to resume thread ${threadId}: ${error}`);
        }
    }

    async stepThread(
        threadId: number,
        size: number = 1, // LINE
        depth: number = 1  // OVER
    ): Promise<void> {
        if (!this.jdwpClient) {
            throw new Error('JDWP client is not connected');
        }

        try {
            await this.jdwpClient.stepThread(threadId, size, depth);
        } catch (error) {
            throw new Error(`Failed to step thread ${threadId}: ${error}`);
        }
    }

    private onBreakpointHit(event: JDWPEvent): void {
        console.log(`Breakpoint hit in thread ${event.threadId}`);
        // Here you would typically:
        // 1. Suspend the VM or specific threads
        // 2. Inspect variables and state
        // 3. Allow the user to step through code
        // 4. Eventually resume execution
    }

    private createEventRequestClearPacket(requestId: number): Uint8Array {
        const data = new Uint8Array(1);
        data[0] = 2; // EventKind.BREAKPOINT
        // Note: This is a simplified implementation
        // A real implementation would need to properly format the clear request
        return data;
    }

    // Helper method to find the PID of a running app
    async findAppPid(packageName: string): Promise<number> {
        try {
            // TODO refactor to expose this method
            // const shell = await  this.adb.subprocess.spawn('ps');
            const processDesc = await adbRun(this.adb, 'ps');
            const output = processDesc.output;
            // await shell.exit;

            const lines = output.split('\n');
            for (const line of lines) {
                if (line.includes(packageName)) {
                    const match = line.match(/^\w+\s+(\d+)/);
                    if (match) {
                        return parseInt(match[1], 10);
                    }
                }
            }

            throw new Error(`Process not found for package: ${packageName}`);
        } catch (error) {
            throw new Error(`Failed to find PID for ${packageName}: ${error}`);
        }
    }
}
