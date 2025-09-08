// jdwp-client.ts - Main JDWP client implementation
import {
    JDWPPacket,
    JDWPCommandSet,
    JDWPEventKind,
    JDWPSuspendPolicy,
    JDWPStepDepth,
    JDWPStepSize,
    JDWPLocation,
    JDWPEvent,
    JDWPTransport,
    JDWPError
} from './protocol';


export class JDWPClient {
    private packetIdCounter: number = 1;
    private eventRequestIdCounter: number = 1;
    private eventCallbacks: Map<number, (event: JDWPEvent) => void> = new Map();
    private responseHandlers: Map<number, {
        resolve: (packet: JDWPPacket) => void,
        reject: (error: Error) => void,
        timeout: number
    }> = new Map();

    constructor(private transport: JDWPTransport) {}

    async connect(): Promise<void> {
        await this.transport.connect();
        this.transport.onPacket(this.handlePacket.bind(this));
    }

    async disconnect(): Promise<void> {
        // Clear all timeouts
        for (const handler of this.responseHandlers.values()) {
            clearTimeout(handler.timeout);
        }
        this.responseHandlers.clear();
        this.eventCallbacks.clear();

        await this.transport.disconnect();
    }

    private async handlePacket(data: Uint8Array): Promise<void> {
        try {
            const packet = this.parsePacket(data);

            if (packet.flags === 0x80) { // Response packet
                const handler = this.responseHandlers.get(packet.id);
                if (handler) {
                    clearTimeout(handler.timeout);
                    this.responseHandlers.delete(packet.id);

                    if (packet.data.length >= 2) {
                        const errorCode = this.readUint16(packet.data, 0);
                        if (errorCode !== 0) {
                            handler.reject(new JDWPError(errorCode, packet.id,
                                `JDWP command failed with error code ${errorCode}`));
                            return;
                        }
                    }

                    handler.resolve(packet);
                }
            } else { // Event packet
                this.handleEventPacket(packet);
            }
        } catch (error) {
            console.error('Error handling JDWP packet:', error);
        }
    }

    private handleEventPacket(packet: JDWPPacket): void {
        if (packet.commandSet === 64 && packet.command === 100) { // Composite event
            const events = this.parseCompositeEvent(packet.data);
            for (const event of events) {
                const callback = this.eventCallbacks.get(event.requestId);
                if (callback) {
                    callback(event);
                }
            }
        }
    }

    private parseCompositeEvent(data: Uint8Array): JDWPEvent[] {
        const events: JDWPEvent[] = [];
        let offset = 0;

        const suspendPolicy = this.readUint8(data, offset);
        offset += 1;

        const eventsCount = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < eventsCount; i++) {
            const eventKind = this.readUint8(data, offset) as JDWPEventKind;
            offset += 1;

            const requestId = this.readUint32(data, offset);
            offset += 4;

            const threadId = this.readObjectId(data, offset);
            offset += 8;

            const event: JDWPEvent = {
                eventKind,
                requestId,
                threadId
            };

            // Parse event-specific data
            switch (eventKind) {
                case JDWPEventKind.BREAKPOINT:
                    event.location = this.readLocation(data, offset);
                    offset += this.getLocationSize();
                    break;
                // Handle other event types
                default:
                    // Skip unknown event data
                    offset += this.getEventDataSize(eventKind, data, offset);
            }

            events.push(event);
        }

        return events;
    }

    async sendCommand(
        commandSet: number,
        command: number,
        data: Uint8Array = new Uint8Array(0),
        timeoutMs: number = 5000
    ): Promise<JDWPPacket> {
        if (!this.transport.isConnected()) {
            throw new Error('JDWP transport is not connected');
        }

        const packetId = this.packetIdCounter++;
        const packet = this.createPacket(packetId, commandSet, command, data);

        return new Promise<JDWPPacket>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.responseHandlers.delete(packetId);
                reject(new Error(`JDWP command timeout after ${timeoutMs}ms`));
            }, timeoutMs);

            this.responseHandlers.set(packetId, { resolve, reject, timeout });

            this.transport.sendPacket(packet).catch(error => {
                clearTimeout(timeout);
                this.responseHandlers.delete(packetId);
                reject(error);
            });
        });
    }

    private createPacket(
        id: number,
        commandSet: number,
        command: number,
        data: Uint8Array
    ): Uint8Array {
        const length = 11 + data.length;
        const packet = new Uint8Array(length);

        this.writeUint32(packet, 0, length);
        this.writeUint32(packet, 4, id);
        packet[8] = 0; // Flags
        packet[9] = commandSet;
        packet[10] = command;

        if (data.length > 0) {
            packet.set(data, 11);
        }

        return packet;
    }

    private parsePacket(data: Uint8Array): JDWPPacket {
        if (data.length < 11) {
            throw new Error('Invalid JDWP packet: too short');
        }

        return {
            length: this.readUint32(data, 0),
            id: this.readUint32(data, 4),
            flags: data[8],
            commandSet: data[9],
            command: data[10],
            data: data.slice(11)
        };
    }

    // High-level command methods
    async setBreakpoint(classId: number, methodId: number, index: number = 0): Promise<number> {
        const requestId = this.eventRequestIdCounter++;
        const data = new Uint8Array(26);
        let offset = 0;

        // Event kind
        this.writeUint8(data, offset, JDWPEventKind.BREAKPOINT);
        offset += 1;

        // Suspend policy
        this.writeUint8(data, offset, JDWPSuspendPolicy.ALL);
        offset += 1;

        // Modifiers count
        this.writeUint32(data, offset, 1);
        offset += 4;

        // Location modifier
        this.writeUint8(data, offset, 1); // LocationOnly modifier
        offset += 1;

        // Location
        this.writeLocation(data, offset, {
            typeTag: 1, // Class
            classId,
            methodId,
            index
        });

        await this.sendCommand(15, 1, data); // EventRequest.Set

        return requestId;
    }

    async setBreakpointAtMethodEntry(classSignature: string, methodName: string): Promise<number> {
        const classId = await this.getReferenceTypeId(classSignature);
        const methods = await this.getMethods(classId);
        const method = methods.find(m => m.name === methodName);

        if (!method) {
            throw new Error(`Method ${methodName} not found in class ${classSignature}`);
        }

        return this.setBreakpoint(classId, method.id, 0);
    }

    async resumeThread(threadId: number): Promise<void> {
        const data = new Uint8Array(4);
        this.writeUint32(data, 0, threadId);
        await this.sendCommand(JDWPCommandSet.ThreadReference, 1, data); // Resume
    }

    async stepThread(
        threadId: number,
        size: JDWPStepSize = JDWPStepSize.LINE,
        depth: JDWPStepDepth = JDWPStepDepth.OVER
    ): Promise<void> {
        const data = new Uint8Array(6);
        let offset = 0;

        this.writeUint32(data, offset, threadId);
        offset += 4;

        this.writeUint8(data, offset, size);
        offset += 1;

        this.writeUint8(data, offset, depth);

        await this.sendCommand(JDWPCommandSet.ThreadReference, 9, data); // Step
    }

    async getReferenceTypeId(signature: string): Promise<number> {
        // Convert signature to bytes
        const encoder = new TextEncoder();
        const signatureBytes = encoder.encode(signature);

        const data = new Uint8Array(signatureBytes.length + 1);
        data.set(signatureBytes, 0);
        data[signatureBytes.length] = 0; // Null terminator

        const response = await this.sendCommand(
            JDWPCommandSet.VirtualMachine,
            2, // ClassesBySignature
            data
        );

        // Parse response to get class ID
        let offset = 0;
        const classesCount = this.readUint32(response.data, offset);
        offset += 4;

        if (classesCount === 0) {
            throw new Error(`Class not found: ${signature}`);
        }

        // Read type tag (skip)
        offset += 1;

        // Read type ID
        const typeId = this.readReferenceTypeId(response.data, offset);

        return typeId;
    }

    async getMethods(classId: number): Promise<Array<{ id: number, name: string }>> {
        const data = new Uint8Array(8);
        this.writeReferenceTypeId(data, 0, classId);

        const response = await this.sendCommand(
            JDWPCommandSet.ReferenceType,
            5, // Methods
            data
        );

        let offset = 0;
        const methodsCount = this.readUint32(response.data, offset);
        offset += 4;

        const methods: Array<{ id: number, name: string }> = [];

        for (let i = 0; i < methodsCount; i++) {
            const methodId = this.readMethodId(response.data, offset);
            offset += 8;

            const nameLength = this.readUint32(response.data, offset);
            offset += 4;

            const nameBytes = response.data.slice(offset, offset + nameLength);
            offset += nameLength;

            const name = new TextDecoder().decode(nameBytes);

            // Skip signature and modifier bits
            const sigLength = this.readUint32(response.data, offset);
            offset += 4 + sigLength + 4;

            methods.push({ id: methodId, name });
        }

        return methods;
    }

    onEvent(requestId: number, callback: (event: JDWPEvent) => void): void {
        this.eventCallbacks.set(requestId, callback);
    }

    removeEventListener(requestId: number): void {
        this.eventCallbacks.delete(requestId);
    }

    // Binary read/write helpers
    private readUint8(data: Uint8Array, offset: number): number {
        return data[offset];
    }

    private writeUint8(data: Uint8Array, offset: number, value: number): void {
        data[offset] = value;
    }

    private readUint16(data: Uint8Array, offset: number): number {
        return (data[offset] << 8) | data[offset + 1];
    }

    private writeUint16(data: Uint8Array, offset: number, value: number): void {
        data[offset] = (value >> 8) & 0xFF;
        data[offset + 1] = value & 0xFF;
    }

    private readUint32(data: Uint8Array, offset: number): number {
        return (data[offset] << 24) |
               (data[offset + 1] << 16) |
               (data[offset + 2] << 8) |
               data[offset + 3];
    }

    private writeUint32(data: Uint8Array, offset: number, value: number): void {
        data[offset] = (value >> 24) & 0xFF;
        data[offset + 1] = (value >> 16) & 0xFF;
        data[offset + 2] = (value >> 8) & 0xFF;
        data[offset + 3] = value & 0xFF;
    }

    private readObjectId(data: Uint8Array, offset: number): number {
        return this.readUint64(data, offset);
    }

    private writeObjectId(data: Uint8Array, offset: number, value: number): void {
        this.writeUint64(data, offset, value);
    }

    private readReferenceTypeId(data: Uint8Array, offset: number): number {
        return this.readUint64(data, offset);
    }

    private writeReferenceTypeId(data: Uint8Array, offset: number, value: number): void {
        this.writeUint64(data, offset, value);
    }

    private readMethodId(data: Uint8Array, offset: number): number {
        return this.readUint64(data, offset);
    }

    private writeMethodId(data: Uint8Array, offset: number, value: number): void {
        this.writeUint64(data, offset, value);
    }

    private readUint64(data: Uint8Array, offset: number): number {
        // JavaScript numbers are 64-bit floats, but we can only represent 53-bit integers
        // For JDWP, we'll use the full 64 bits as a BigInt if needed, but for simplicity
        // we'll assume the IDs fit in 53 bits
        const high = this.readUint32(data, offset);
        const low = this.readUint32(data, offset + 4);
        return (high * 0x100000000) + low;
    }

    private writeUint64(data: Uint8Array, offset: number, value: number): void {
        const high = Math.floor(value / 0x100000000);
        const low = value % 0x100000000;
        this.writeUint32(data, offset, high);
        this.writeUint32(data, offset + 4, low);
    }

    private readLocation(data: Uint8Array, offset: number): JDWPLocation {
        return {
            typeTag: this.readUint8(data, offset),
            classId: this.readReferenceTypeId(data, offset + 1),
            methodId: this.readMethodId(data, offset + 9),
            index: this.readUint64(data, offset + 17)
        };
    }

    private writeLocation(data: Uint8Array, offset: number, location: JDWPLocation): void {
        this.writeUint8(data, offset, location.typeTag);
        this.writeReferenceTypeId(data, offset + 1, location.classId);
        this.writeMethodId(data, offset + 9, location.methodId);
        this.writeUint64(data, offset + 17, location.index);
    }

    private getLocationSize(): number {
        return 1 + 8 + 8 + 8; // typeTag + classId + methodId + index
    }

    private getEventDataSize(eventKind: JDWPEventKind, data: Uint8Array, offset: number): number {
        // This is a simplified implementation
        // A real implementation would properly parse each event type
        switch (eventKind) {
            case JDWPEventKind.BREAKPOINT:
                return this.getLocationSize();
            case JDWPEventKind.EXCEPTION:
                return 8 + 8 + 1; // exceptionId + threadId + catchLocation
            // Add cases for other event types
            default:
                return 0; // Unknown event, skip
        }
    }
}
