// adb-jdwp-transport.ts - Correct WebUSB ADB implementation
import {AdbDaemonConnection, AdbPacket, AdbPacketData, AdbPacketInit,
    AdbCommand, AdbPacketDispatcher, AdbPacketDispatcherOptions,
    AdbTransport, calculateChecksum} from "@yume-chan/adb";
import {Consumable, ReadableWritablePair} from "@yume-chan/stream-extra";
import { JDWPTransport } from './protocol';

export class AdbJDWPTransport implements JDWPTransport {
    private connection: AdbDaemonConnection | null = null;
    private writer: WritableStreamDefaultWriter<Consumable<AdbPacketInit>>
        | null = null;
    private reader: ReadableStreamDefaultReader<AdbPacketData> | null = null;
    private packetCallback: ((packet: Uint8Array) => void) | null = null;
    private connected: boolean = false;
    private pendingData: Uint8Array = new Uint8Array(0);

    constructor(private adbConnection: AdbDaemonConnection, private pid:
                number) {}

    async connect(): Promise<void> {
        try {
            // Create a connection to the JDWP service
            // this.connection = await this.adb.createConnection(`jdwp:${this.pid}`);
            this.connection = this.adbConnection;
            // Init ADB packet
            // TODO there must a better way to define this
            const dispatcherOpts: AdbPacketDispatcherOptions = {
                calculateChecksum: true,
                appendNullToServiceString: true,
                preserveConnection: false,
                maxPayloadSize: 255,
                initialDelayedAckBytes: 0,
            };
            const dispatcher = new AdbPacketDispatcher(this.connection, dispatcherOpts);
            // Something more similar to this, or in alternative sendPacket
            // which can send a raw ADB packet!
            const connection = await dispatcher.createSocket(`jdwp:${this.pid}`)
            // Set up the writer and reader
            this.writer = this.connection.writable.getWriter();
            this.reader = this.connection.readable.getReader() as ReadableStreamDefaultReader<AdbPacketData>;
            this.connected = true;

            // Start reading loop
            this.readLoop().catch(error => {
                console.error('JDWP read loop error:', error);
                this.connected = false;
                connection.close();
            });
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

        if (this.connection) {
            this.connection = null;
        }

        this.packetCallback = null;
        this.pendingData = new Uint8Array(0);
    }

    async sendPacket(packet: Uint8Array): Promise<void> {
        if (!this.writer || !this.connected) {
            throw new Error('JDWP transport is not connected');
        }

        try {
            // Create ADB packet with the JDWP data
            const adbPacket = {
                command: AdbCommand.Write,
                arg0: 0,
                arg1: 0,
                payload: packet,
                // TODO are those fields filled in by the library?
                magic: (AdbCommand.Write ^ 0xffffffff) ,
                checksum: calculateChecksum(packet),
            };

            await this.writer.write(new Consumable(adbPacket as AdbPacketInit));
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
                    this.connected = false;
                    break;
                }

                if (value && value.payload && this.packetCallback) {
                    // Handle ADB packet and extract JDWP data
                    await this.handleAdbPacket(value);
                }
            }
        } catch (error) {
            if (this.connected) {
                console.error('Error in JDWP read loop:', error);
            }
            this.connected = false;
        }
    }

    private async handleAdbPacket(packet: AdbPacketData): Promise<void> {
        if (packet.command === AdbCommand.Write && packet.payload) {
            // Convert payload to Uint8Array if it's not already
            let data: Uint8Array;
            if (packet.payload instanceof Uint8Array) {
                data = packet.payload;
            } else {
                // Handle other payload types if needed
                data = new TextEncoder().encode(String(packet.payload));
            }

            // Append to pending data
            const newData = new Uint8Array(this.pendingData.length + data.length);
            newData.set(this.pendingData, 0);
            newData.set(data, this.pendingData.length);
            this.pendingData = newData;

            // Process complete JDWP packets
            await this.processJdwpPackets();
        } else if (packet.command === AdbCommand.Close) {
            // Handle connection close
            this.connected = false;
        }
    }

    private async processJdwpPackets(): Promise<void> {
        while (this.pendingData.length >= 11) { // Minimum JDWP packet size
            // Read packet length (first 4 bytes)
            const length = this.readUint32(this.pendingData, 0);

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
                this.packetCallback(packetData);
            }
        }
    }

    private readUint32(data: Uint8Array, offset: number): number {
        return (data[offset] << 24) |
               (data[offset + 1] << 16) |
               (data[offset + 2] << 8) |
               data[offset + 3];
    }

}
