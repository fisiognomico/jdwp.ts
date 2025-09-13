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
    JDWPError,
    JDWPValue,
    JDWPTagType,
    JDWPStackFrame,
    JDWPLocalVariable
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

    // Cache for performance
    private classSignatureCache: Map<number, string> = new Map();
    private methodNameCache: Map<number, string> = new Map();

    constructor(private transport: JDWPTransport) {}



    async connect(): Promise<void> {
        try {
            await this.transport.connect();
            this.transport.onPacket(this.handlePacket.bind(this));
        } catch (error) {
            console.error("Can not connect to device: ", error)
        }
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

            this.responseHandlers.set(packetId, { resolve, reject, timeout: timeoutMs });

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

    async getStackFrames(threadId: number, startFrame: number = 0, length: number = -1): Promise<JDWPStackFrame[]> {
        const data = new Uint8Array(20);
        let offset = 0;

        this.writeObjectId(data, offset, threadId);
        offset += 8;
        this.writeUint32(data, offset, startFrame);
        offset += 4;
        this.writeUint32(data, offset, length);

        const response = await this.sendCommand(
            JDWPCommandSet.ThreadReference,
            6, // Frames command
            data
        );

        return this.parseStackFrames(response.data);
    }

    async getLocalVariables(threadId: number, frameId: number): Promise<JDWPLocalVariable[]> {
        // First, get the frame info to get method ID
        const frameData = new Uint8Array(16);
        this.writeObjectId(frameData, 0, threadId);
        this.writeObjectId(frameData, 8, frameId);

        const frameResponse = await this.sendCommand(
            JDWPCommandSet.StackFrame,
            1, // GetValues command
            frameData
        );

        // Parse method ID from frame
        const location = this.readLocation(frameResponse.data, 0);

        // Get variable table for the method
        const varTableData = new Uint8Array(16);
        this.writeReferenceTypeId(varTableData, 0, location.classId);
        this.writeMethodId(varTableData, 8, location.methodId);

        const varTableResponse = await this.sendCommand(
            JDWPCommandSet.Method,
            2, // VariableTable command
            varTableData
        );

        return this.parseVariableTable(varTableResponse.data);
    }

    async getVariableValue(threadId: number, frameId: number, slot: number, tag: JDWPTagType): Promise<JDWPValue> {
        const data = new Uint8Array(21);
        let offset = 0;

        this.writeObjectId(data, offset, threadId);
        offset += 8;
        this.writeObjectId(data, offset, frameId);
        offset += 8;
        this.writeUint32(data, offset, 1); // slots count
        offset += 4;
        this.writeUint32(data, offset, slot);
        offset += 4;
        this.writeUint8(data, offset, tag);

        const response = await this.sendCommand(
            JDWPCommandSet.StackFrame,
            1, // GetValues command
            data
        );

        return this.parseValue(response.data, 4); // Skip count field
    }

    async getObjectFields(objectId: number): Promise<Map<string, JDWPValue>> {
        // First, get the reference type of the object
        const refTypeData = new Uint8Array(8);
        this.writeObjectId(refTypeData, 0, objectId);

        const refTypeResponse = await this.sendCommand(
            JDWPCommandSet.ObjectReference,
            1, // ReferenceType command
            refTypeData
        );

        const refTypeId = this.readReferenceTypeId(refTypeResponse.data, 1);

        // Get fields for the reference type
        const fieldsData = new Uint8Array(8);
        this.writeReferenceTypeId(fieldsData, 0, refTypeId);

        const fieldsResponse = await this.sendCommand(
            JDWPCommandSet.ReferenceType,
            4, // Fields command
            fieldsData
        );

        const fields = this.parseFields(fieldsResponse.data);

        // Get values for all fields
        const getValuesData = new Uint8Array(8 + 4 + fields.length * 8);
        let offset = 0;
        this.writeObjectId(getValuesData, offset, objectId);
        offset += 8;
        this.writeUint32(getValuesData, offset, fields.length);
        offset += 4;

        for (const field of fields) {
            this.writeFieldId(getValuesData, offset, field.id);
            offset += 8;
        }

        const valuesResponse = await this.sendCommand(
            JDWPCommandSet.ObjectReference,
            2, // GetValues command
            getValuesData
        );

        return this.parseFieldValues(fields, valuesResponse.data);
    }

    async getStringValue(stringObjectId: number): Promise<string> {
        const data = new Uint8Array(8);
        this.writeObjectId(data, 0, stringObjectId);

        const response = await this.sendCommand(
            JDWPCommandSet.StringReference,
            1, // Value command
            data
        );

        const length = this.readUint32(response.data, 0);
        return new TextDecoder().decode(response.data.slice(4, 4 + length));
    }

    async getArrayValues(arrayObjectId: number, firstIndex: number = 0, length: number = -1): Promise<JDWPValue[]> {
        // Get array length if not specified
        if (length === -1) {
            const lengthData = new Uint8Array(8);
            this.writeObjectId(lengthData, 0, arrayObjectId);

            const lengthResponse = await this.sendCommand(
                JDWPCommandSet.ArrayReference,
                1, // Length command
                lengthData
            );

            length = this.readUint32(lengthResponse.data, 0);
        }

        const data = new Uint8Array(16);
        this.writeObjectId(data, 0, arrayObjectId);
        this.writeUint32(data, 8, firstIndex);
        this.writeUint32(data, 12, length);

        const response = await this.sendCommand(
            JDWPCommandSet.ArrayReference,
            2, // GetValues command
            data
        );

        return this.parseArrayValues(response.data);
    }

    // === Breakpoint Management ===

    async clearBreakpoint(requestId: number): Promise<void> {
        const data = new Uint8Array(5);
        this.writeUint8(data, 0, JDWPEventKind.BREAKPOINT);
        this.writeUint32(data, 1, requestId);

        await this.sendCommand(
            JDWPCommandSet.EventRequest,
            2, // Clear command
            data
        );
    }

    async clearAllBreakpoints(): Promise<void> {
        // Clear all event requests
        await this.sendCommand(
            JDWPCommandSet.EventRequest,
            3, // ClearAllBreakpoints command
            new Uint8Array(0)
        );
    }

    // === Evaluation ===

    async invokeMethod(
        objectId: number,
        threadId: number,
        classId: number,
        methodId: number,
        args: JDWPValue[] = [],
        options: number = 0
    ): Promise<JDWPValue> {
        const data = new Uint8Array(32 + args.length * 9); // Approximate size
        let offset = 0;

        this.writeObjectId(data, offset, objectId);
        offset += 8;
        this.writeObjectId(data, offset, threadId);
        offset += 8;
        this.writeReferenceTypeId(data, offset, classId);
        offset += 8;
        this.writeMethodId(data, offset, methodId);
        offset += 8;
        this.writeUint32(data, offset, args.length);
        offset += 4;

        for (const arg of args) {
            offset += this.writeValue(data, offset, arg);
        }

        this.writeUint32(data, offset, options);

        const response = await this.sendCommand(
            JDWPCommandSet.ObjectReference,
            6, // InvokeMethod command
            data.slice(0, offset + 4)
        );

        return this.parseValue(response.data, 0);
    }

    // Parser helpers
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

        private parseStackFrames(data: Uint8Array): JDWPStackFrame[] {
        const frames: JDWPStackFrame[] = [];
        let offset = 0;

        const frameCount = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < frameCount; i++) {
            const frameId = this.readObjectId(data, offset);
            offset += 8;

            const location = this.readLocation(data, offset);
            offset += this.getLocationSize();

            frames.push({
                frameId,
                location,
                threadId: 0 // Will be filled by caller
            });
        }

        return frames;
    }

    private parseVariableTable(data: Uint8Array): JDWPLocalVariable[] {
        const variables: JDWPLocalVariable[] = [];
        let offset = 0;

        const argCount = this.readUint32(data, offset);
        offset += 4;

        const varCount = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < varCount; i++) {
            const codeIndex = this.readUint64(data, offset);
            offset += 8;

            const nameLength = this.readUint32(data, offset);
            offset += 4;
            const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
            offset += nameLength;

            const signatureLength = this.readUint32(data, offset);
            offset += 4;
            const signature = new TextDecoder().decode(data.slice(offset, offset + signatureLength));
            offset += signatureLength;

            const length = this.readUint32(data, offset);
            offset += 4;

            const slot = this.readUint32(data, offset);
            offset += 4;

            variables.push({
                codeIndex,
                name,
                signature,
                length,
                slot,
                isArgument: i < argCount
            });
        }

        return variables;
    }

    private parseValue(data: Uint8Array, offset: number): JDWPValue {
        const tag = this.readUint8(data, offset) as JDWPTagType;
        offset += 1;

        let value: any;
        switch (tag) {
            case JDWPTagType.BYTE:
                value = this.readInt8(data, offset);
                break;
            case JDWPTagType.CHAR:
            case JDWPTagType.SHORT:
                value = this.readInt16(data, offset);
                break;
            case JDWPTagType.INT:
            case JDWPTagType.FLOAT:
                value = this.readInt32(data, offset);
                break;
            case JDWPTagType.LONG:
            case JDWPTagType.DOUBLE:
                value = this.readInt64(data, offset);
                break;
            case JDWPTagType.BOOLEAN:
                value = this.readUint8(data, offset) !== 0;
                break;
            case JDWPTagType.STRING:
            case JDWPTagType.OBJECT:
            case JDWPTagType.ARRAY:
            case JDWPTagType.THREAD:
            case JDWPTagType.THREAD_GROUP:
            case JDWPTagType.CLASS_LOADER:
            case JDWPTagType.CLASS_OBJECT:
                value = this.readObjectId(data, offset);
                break;
            case JDWPTagType.VOID:
                value = null;
                break;
            default:
                value = null;
        }

        return { tag, value };
    }

    private writeValue(data: Uint8Array, offset: number, value: JDWPValue): number {
        this.writeUint8(data, offset, value.tag);
        offset += 1;

        switch (value.tag) {
            case JDWPTagType.BYTE:
                this.writeInt8(data, offset, value.value);
                return 2;
            case JDWPTagType.SHORT:
            case JDWPTagType.CHAR:
                this.writeInt16(data, offset, value.value);
                return 3;
            case JDWPTagType.INT:
            case JDWPTagType.FLOAT:
                this.writeInt32(data, offset, value.value);
                return 5;
            case JDWPTagType.LONG:
            case JDWPTagType.DOUBLE:
                this.writeInt64(data, offset, value.value);
                return 9;
            case JDWPTagType.BOOLEAN:
                this.writeUint8(data, offset, value.value ? 1 : 0);
                return 2;
            case JDWPTagType.STRING:
            case JDWPTagType.OBJECT:
            case JDWPTagType.ARRAY:
                this.writeObjectId(data, offset, value.value);
                return 9;
            default:
                return 1;
        }
    }

    private parseFields(data: Uint8Array): Array<{ id: number, name: string, signature: string, modifiers: number }> {
        const fields: Array<{ id: number, name: string, signature: string, modifiers: number }> = [];
        let offset = 0;

        const fieldCount = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < fieldCount; i++) {
            const fieldId = this.readFieldId(data, offset);
            offset += 8;

            const nameLength = this.readUint32(data, offset);
            offset += 4;
            const name = new TextDecoder().decode(data.slice(offset, offset + nameLength));
            offset += nameLength;

            const signatureLength = this.readUint32(data, offset);
            offset += 4;
            const signature = new TextDecoder().decode(data.slice(offset, offset + signatureLength));
            offset += signatureLength;

            const modifiers = this.readUint32(data, offset);
            offset += 4;

            fields.push({ id: fieldId, name, signature, modifiers });
        }

        return fields;
    }

    private parseFieldValues(
        fields: Array<{ id: number, name: string, signature: string, modifiers: number }>,
        data: Uint8Array
    ): Map<string, JDWPValue> {
        const result = new Map<string, JDWPValue>();
        let offset = 0;

        const count = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < count && i < fields.length; i++) {
            const value = this.parseValue(data, offset);
            offset += this.getValueSize(value.tag);
            result.set(fields[i].name, value);
        }

        return result;
    }

    private parseArrayValues(data: Uint8Array): JDWPValue[] {
        const values: JDWPValue[] = [];
        let offset = 0;

        const tag = this.readUint8(data, offset) as JDWPTagType;
        offset += 1;

        const count = this.readUint32(data, offset);
        offset += 4;

        for (let i = 0; i < count; i++) {
            const value = this.parseValue(data, offset - 1); // Include tag
            values.push(value);
            offset += this.getValueSize(tag) - 1; // Exclude tag
        }

        return values;
    }

    private getValueSize(tag: JDWPTagType): number {
        switch (tag) {
            case JDWPTagType.BYTE:
            case JDWPTagType.BOOLEAN:
                return 2;
            case JDWPTagType.SHORT:
            case JDWPTagType.CHAR:
                return 3;
            case JDWPTagType.INT:
            case JDWPTagType.FLOAT:
                return 5;
            case JDWPTagType.LONG:
            case JDWPTagType.DOUBLE:
            case JDWPTagType.STRING:
            case JDWPTagType.OBJECT:
            case JDWPTagType.ARRAY:
                return 9;
            default:
                return 1;
        }
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

    private readInt8(data: Uint8Array, offset: number): number {
        const val = data[offset];
        return val > 127 ? val - 256 : val;
    }

    private writeInt8(data: Uint8Array, offset: number, value: number): void {
        data[offset] = value & 0xFF;
    }

    private readInt16(data: Uint8Array, offset: number): number {
        const val = this.readUint16(data, offset);
        return val > 32767 ? val - 65536 : val;
    }

    private writeInt16(data: Uint8Array, offset: number, value: number): void {
        this.writeUint16(data, offset, value);
    }

    private readInt32(data: Uint8Array, offset: number): number {
        const val = this.readUint32(data, offset);
        return val > 2147483647 ? val - 4294967296 : val;
    }

    private writeInt32(data: Uint8Array, offset: number, value: number): void {
        this.writeUint32(data, offset, value);
    }

    private readInt64(data: Uint8Array, offset: number): bigint {
        const high = BigInt(this.readUint32(data, offset));
        const low = BigInt(this.readUint32(data, offset + 4));
        return (high << 32n) | low;
    }

    private writeInt64(data: Uint8Array, offset: number, value: number | bigint): void {
        const bigValue = BigInt(value);
        this.writeUint32(data, offset, Number((bigValue >> 32n) & 0xFFFFFFFFn));
        this.writeUint32(data, offset + 4, Number(bigValue & 0xFFFFFFFFn));
    }

    private readFieldId(data: Uint8Array, offset: number): number {
        return this.readUint64(data, offset);
    }

    private writeFieldId(data: Uint8Array, offset: number, value: number): void {
        this.writeUint64(data, offset, value);
    }

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
