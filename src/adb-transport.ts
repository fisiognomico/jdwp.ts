// adb-jdwp-transport.ts - Correct WebUSB ADB implementation
import {Adb, AdbDaemonConnection, AdbSocket, AdbPacketDispatcher,
    AdbPacketDispatcherOptions} from "@yume-chan/adb";
import {ReadableStreamDefaultReader, WritableStreamDefaultWriter } from "@yume-chan/stream-extra";
import { JDWPTransport } from './protocol';
import { performJDWPHandshake } from "./lib";

export class WebUSBJDWPTransport implements JDWPTransport {
    private socket: AdbSocket | null = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private packetCallback: ((packet: Uint8Array) => void) | null = null;
    private connected: boolean = false;
    private pendingData: Uint8Array = new Uint8Array(0);

    constructor(
        private adbConnection: AdbDaemonConnection,
        private pid: number
    ) {}

    async connect(): Promise<void> {
        try {
            // Create dispatcher with proper options
            const dispatcherOpts: AdbPacketDispatcherOptions = {
                calculateChecksum: true,
                appendNullToServiceString: true,
                preserveConnection: false,
                maxPayloadSize: 64 * 1024, // 64KB - standard ADB max payload
                initialDelayedAckBytes: 0,
            };

            const dispatcher = new AdbPacketDispatcher(
                this.adbConnection,
                dispatcherOpts
            );

            // Create socket connection to JDWP service
            this.socket = await dispatcher.createSocket(`jdwp:${this.pid}`);

            // Get readable and writable streams from the socket
            this.reader = this.socket.readable.getReader();
            this.writer = this.socket.writable.getWriter();

            this.connected = true;

            // Perform JDWP handshake
            this.pendingData = await performJDWPHandshake(this.reader, this.writer);
            console.log("[+] Pending data: ", this.pendingData.buffer);

            // Start reading loop
            this.readLoop().catch(error => {
                console.error('JDWP read loop error:', error);
                this.handleDisconnect();
            });

            console.log(`Connected to JDWP service for PID ${this.pid}`);
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
            // Send JDWP packet data directly through the socket
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
