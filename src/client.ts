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
    JDWPLocalVariable,
    JDWPModifierKind,
    JDWPVMCommands,
    EventModifier
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

    // TODO Cache for performance
    // private classSignatureCache: Map<number, string> = new Map();
    // private methodNameCache: Map<number, string> = new Map();

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

    // Handle response and event packets
    private async handlePacket(data: Uint8Array): Promise<void> {
        try {
            const packet = this.parsePacket(data);
            // console.info(`[PACKET] Flags: 0x${packet.flags.toString(16)}, CS: ${packet.commandSet}, Cmd: ${packet.command}, Len: ${packet.data.length}`);

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
                } else {
                    console.log(" [+] Handler not found for packet ", packet.flags);
                }
            } else { // Event packet
                // console.info(`[EVENT CHECK] Calling handleEventPacket`);
                this.handleEventPacket(packet);
            }
        } catch (error) {
            console.error('Error handling JDWP packet:', error);
            console.info('Raw packet data:', Array.from(data.slice(0, Math.min(32, data.length))).map(b => b.toString(16).padStart(2, '0')).join(' '));
        }
    }

    // Event management
    private handleEventPacket(packet: JDWPPacket): void {
        if (packet.commandSet === 64 && packet.command === 100) { // Composite event
            const events = this.parseCompositeEvent(packet.data);
            // console.log(`[COMPOSITE EVENT] Parsed ${events.length} events`);
            for (const event of events) {
                const callback = this.eventCallbacks.get(event.requestId);
                if (callback) {
                    // console.info(`[CALLBACK] Found for request ${event.requestId}`);
                    callback(event);
                } else {
                    console.log(`[NO CALLBACK] for request ${event.requestId}`);
                    // console.info(`[REGISTERED CALLBACKS] ${Array.from(this.eventCallbacks.keys()).join(', ')}`);
                }
            }
        } else {
            console.log(`[NOT COMPOSITE] CS: ${packet.commandSet}, Cmd: ${packet.command}`);
        }
    }

    private parseCompositeEvent(data: Uint8Array): JDWPEvent[] {
        const events: JDWPEvent[] = [];
        let offset = 0;

        const suspendPolicy = this.readUint8(data, offset);
        offset += 1;

        const eventsCount = this.readUint32(data, offset);
        offset += 4;

        // console.info(`[COMPOSITE EVENT] Suspend: ${suspendPolicy}, Count: ${eventsCount}`);

        for (let i = 0; i < eventsCount; i++) {
            const eventKind = this.readUint8(data, offset) as JDWPEventKind;
            offset += 1;

            const requestId = this.readUint32(data, offset);
            offset += 4;

            const threadId = this.readObjectId(data, offset);
            offset += 8;

            // console.info(`[EVENT] Kind: ${eventKind}, Request: ${requestId}, Thread: ${threadId}`);

            const event: JDWPEvent = {
                eventKind,
                requestId,
                threadId
            };

            // Parse event-specific data
            switch (eventKind) {
                case JDWPEventKind.BREAKPOINT:
                case JDWPEventKind.SINGLE_STEP:
                    event.location = this.readLocation(data, offset);
                    offset += this.getLocationSize();
                    console.info(` [BREAKPOINT] Location: ${event.location}, eventID : ${event.requestId}`);
                    break;
                case JDWPEventKind.CLASS_PREPARE:
                    const typeTag = this.readUint8(data, offset);
                    offset += 1;
                    event.refTypeTag = typeTag;

                    const typeId = this.readReferenceTypeId(data, offset);
                    offset += 8;
                    event.typeId = typeId;

                    // Read string length and signature
                    const signLength = this.readUint32(data, offset);
                    offset += 4;

                    const signature = new TextDecoder().decode(
                        data.slice(offset, offset + signLength)
                    );
                    offset += signLength;
                    event.signature = signature;

                    const classStatus = this.readUint32(data, offset);
                    offset += 4;
                    event.status = classStatus;

                    // console.info(`[CLASS_PREPARE] Signature: ${event.signature}, Status: ${event.status}`);
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

    async setupEvent(
        eventKind: JDWPEventKind,
        suspendPolicy: JDWPSuspendPolicy = JDWPSuspendPolicy.NONE,
        eventModifiers: EventModifier[] = []
    ): Promise<number> {
        let size = 6; // eventKind (1) + suspend (1) + modifiersCount (4)
        for (const mod of eventModifiers) {
            size += 1 + mod.data.length; // modKind(1) + data
        }

        const data = new Uint8Array(size);
        let offset = 0;

        this.writeUint8(data, offset++, eventKind);
        this.writeUint8(data, offset++, suspendPolicy);
        this.writeUint32(data, offset, eventModifiers.length);
        offset += 4;

        // Write modifiers
        for (const mod of eventModifiers) {
            this.writeUint8(data, offset++, mod.kind);
            data.set(mod.data, offset);
            offset += mod.data.length;
        }

        const response = await this.sendCommand(15, 1, data);
        return this.readUint32(response.data, 0);
    }

    async setupClassPrepareEvent(classPattern?: string): Promise<number> {
        const modifiers: EventModifier[] = [];

        if (classPattern) {
            const patternBytes = new TextEncoder().encode(classPattern);
            const modData = new Uint8Array(4 + patternBytes.length);
            this.writeUint32(modData, 0, patternBytes.length);
            modData.set(patternBytes, 4);

            modifiers.push({
                kind: JDWPModifierKind.CLASS_MATCH,
                data: modData
            });
        }

        return this.setupEvent(
            JDWPEventKind.CLASS_PREPARE,
            JDWPSuspendPolicy.NONE,
            modifiers
        );
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
    async setBreakpointAtLocation(
        location: JDWPLocation,
        suspendPolicy: JDWPSuspendPolicy = JDWPSuspendPolicy.ALL
    ): Promise<number> {
        const modData = new Uint8Array(25); // size of a location
        this.writeLocation(modData, 0, location);

        const modifiers: EventModifier[] = [{
            kind: JDWPModifierKind.LOCATION_ONLY,
            data: modData
        }];

        return this.setupEvent(
            JDWPEventKind.BREAKPOINT,
            suspendPolicy,
            modifiers
        );
    }

    async setBreakpointAtMethodEntry(
        classSignature: string,
        methodName: string,
        suspendPolicy: JDWPSuspendPolicy = JDWPSuspendPolicy.ALL
    ): Promise<number> {
        const classId = await this.getReferenceTypeId(classSignature);
        const methods = await this.getMethods(classId);
        const method = methods.find(m => m.name === methodName);

        if (!method) {
            throw new Error(`Method ${methodName} not found in class ${classSignature}`);
        }

        const location: JDWPLocation = {
            typeTag: 1, // Class
            classId,
            methodId: method.id,
            index: 0 // Method entry
        };

        return this.setBreakpointAtLocation(location, suspendPolicy);
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

        // Create buffer with 4-byte length prefix
        const data = new Uint8Array(4 + signatureBytes.length);
        // Write length (4 bytes, big-endian)
        this.writeUint32(data, 0, signatureBytes.length);
        // Write string bytes, no null-termination
        data.set(signatureBytes, 4);

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
        case JDWPEventKind.SINGLE_STEP:
        case JDWPEventKind.BREAKPOINT:
            return this.getLocationSize(); // 25 bytes

        case JDWPEventKind.FRAME_POP:
            return this.getLocationSize(); // 25 bytes

        case JDWPEventKind.EXCEPTION:
            return this.getLocationSize() + 8 + this.getLocationSize(); // throwLocation + exception + catchLocation

        case JDWPEventKind.USER_DEFINED:
            return 0; // No additional data

        case JDWPEventKind.THREAD_START:
        case JDWPEventKind.THREAD_DEATH:
            return 0; // Thread ID already read in main loop

        case JDWPEventKind.CLASS_PREPARE:
            // typeTag(1) + typeID(8) + signature(string) + status(4)
            const sigLength = this.readUint32(data, offset + 9);
            return 1 + 8 + 4 + sigLength + 4;

        case JDWPEventKind.CLASS_UNLOAD:
            // signature(string)
            const unloadSigLength = this.readUint32(data, offset);
            return 4 + unloadSigLength;

        case JDWPEventKind.CLASS_LOAD:
            // typeTag(1) + typeID(8) + signature(string) + status(4)
            const loadSigLength = this.readUint32(data, offset + 9);
            return 1 + 8 + 4 + loadSigLength + 4;

        case JDWPEventKind.FIELD_ACCESS:
        case JDWPEventKind.FIELD_MODIFICATION:
            // typeTag(1) + typeID(8) + fieldID(8) + objectID(8) + location(25)
            return 1 + 8 + 8 + 8 + this.getLocationSize();

        case JDWPEventKind.EXCEPTION_CATCH:
            // location(25) + typeTag(1) + typeID(8) + methodID(8) + index(8)
            return this.getLocationSize() + 1 + 8 + 8 + 8;

        case JDWPEventKind.METHOD_ENTRY:
        case JDWPEventKind.METHOD_EXIT:
            return this.getLocationSize(); // 25 bytes

        case JDWPEventKind.METHOD_EXIT_WITH_RETURN_VALUE:
            // location(25) + value(variable)
            const valueTag = this.readUint8(data, offset + this.getLocationSize());
            return this.getLocationSize() + this.getValueSize(valueTag as JDWPTagType);

        case JDWPEventKind.MONITOR_CONTENDED_ENTER:
        case JDWPEventKind.MONITOR_CONTENDED_ENTERED:
        case JDWPEventKind.MONITOR_WAIT:
        case JDWPEventKind.MONITOR_WAITED:
            // typeTag(1) + typeID(8) + location(25)
            return 1 + 8 + this.getLocationSize();

        case JDWPEventKind.VM_START:
            return 0; // Thread ID already read

        case JDWPEventKind.VM_DEATH:
        case JDWPEventKind.VM_DISCONNECTED:
            return 0; // No additional data

        default:
            console.warn(`Unknown event kind: ${eventKind}, assuming no additional data`);
            return 0;
        }
    }

    // For debugging porpouse
    public testParseEvent(bytes: Uint8Array): void {
        // Wireshark directly outputs in C arrays
        // const hex = hexString.replace(/\s+/g, '');
        // const bytes = new Uint8Array(hex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

        console.log(`Testing parse of ${bytes.length} bytes`);
        const packet = this.parsePacket(bytes);
        console.info(`[PACKET] Flags: 0x${packet.flags.toString(16)}, CS: ${packet.commandSet}, Cmd: ${packet.command}, Len: ${packet.data.length}`);
        const handle = this.handlePacket(bytes);

        console.log("Number of registered handlers: ", this.responseHandlers.size);
        if (packet.commandSet === 64 && packet.command === 100) {
            const events = this.parseCompositeEvent(packet.data);
            console.log(`Parsed ${events.length} events:`, events);
        }
    }

    // Utilities to invoke debugged code.

    /**
     * Create a new string object in the JVM
     */
    async createString(value: string): Promise<number> {
        const encoder = new TextEncoder();
        const stringBytes = encoder.encode(value);

        const data = new Uint8Array(4 + stringBytes.length);
        this.writeUint32(data, 0, stringBytes.length);
        data.set(stringBytes, 4);

        const response = await this.sendCommand(
            JDWPCommandSet.VirtualMachine,
            JDWPVMCommands.CreateString,
            data
        );

        // Response contains the string object ID
        return this.readObjectId(response.data, 0);
    }
    /*
     * Get field ID by name from a class
     */
    async getFieldId(
        classId: number,
        fieldName: string,
        signature: string
    ): Promise<number> {
        const fieldsData = new Uint8Array(8);
        this.writeReferenceTypeId(fieldsData, 0, classId);

        const response = await this.sendCommand(
            JDWPCommandSet.ReferenceType,
            4, // Fields command
            fieldsData
        );

        const fields = this.parseFields(response.data);
        const field = fields.find(f => f.name === fieldName && f.signature === signature);

        if(!field) {
            throw new Error(`Field ${fieldName} with signature ${signature} not found`);
        }

        return field.id;
    }

    /*
     * Invoke a static method from a class
     */
    async invokeStaticMethod(
        classId: number,
        threadId: number,
        methodId: number,
        args: JDWPValue[] = [],
        options: number = 0
    ): Promise<JDWPValue> {
        const data = new Uint8Array(28 + args.length * 9); // Approximate size
        let offset = 0;

        // Class ID (8 bytes)
        this.writeReferenceTypeId(data, offset, classId);
        offset += 8;

        // Thread ID (8 bytes)
        this.writeReferenceTypeId(data, offset, threadId);
        offset += 8;

        // Method ID (8 bytes)
        this.writeReferenceTypeId(data, offset, methodId);
        offset += 8;

        // Get arguments count (4 bytes)
        this.writeUint32(data, offset, args.length);
        offset += 4;

        // Arguments
        for (const arg in args) {
            const wrapper: JDWPValue = {tag: JDWPTagType.STRING, value: arg};
            offset += this.writeValue(data, offset, wrapper);
        }

        // Invoke options, typically 0
        this.writeUint32(data, offset, 0);

        const response = await this.sendCommand(
            JDWPCommandSet.ClassType,
            3, // Invoke Method
            data.slice(0, offset+4)
        );

        return this.parseValue(response.data, 0);
    }

    /*
     * Get methodId by name and signature
     */
    async getMethodId(
        classId: number,
        methodName: string,
        signature: string
    ): Promise<number> {
        // We need to get full method info with signature
        const methodsData = new Uint8Array(8);
        this.writeReferenceTypeId(methodsData, 0, classId);

        const response = await this.sendCommand(
            JDWPCommandSet.ReferenceType,
            5, // Methods command
            methodsData
        );

        let offset = 0;
        const methodCount = this.readUint32(response.data, offset);
        offset += 4;

        for (let i = 0; i < methodCount; i++) {
            const methodId = this.readMethodId(response.data, offset);
            offset += 8;

            const nameLength = this.readUint32(response.data, offset);
            offset += 4;
            const name = new TextDecoder().decode(
                response.data.slice(offset, offset + nameLength)
            );
            offset += nameLength;

            const sigLength = this.readUint32(response.data, offset);
            offset += 4;
            const sig = new TextDecoder().decode(
                response.data.slice(offset, offset + sigLength)
            );
            offset += sigLength;

            const modifiers = this.readUint32(response.data, offset);
            offset += 4;

            if (name === methodName && sig === signature) {
                return methodId;
            }
        }

        throw new Error(`Method ${methodName}${signature} not found`);

    }

    async getFirstMethodId(
        classId: number,
        methodNameWithSignature: string
    ): Promise<number> {
        // Parse method name and signature
        // Format methodName(args)returnType
        const parenIndex = methodNameWithSignature.indexOf('(');
        if(parenIndex == -1) {
            throw new Error(`Invalid method signature: ${methodNameWithSignature}`);
        }

        const methodName = methodNameWithSignature.substring(0, parenIndex);
        const signature = methodNameWithSignature.substring(parenIndex);

        return await this.getMethodId(classId, methodName, signature);
    }

    /*
     * Get runtime instance (Runtime.runtime())
     */
    async getRuntime(threadId: number): Promise<number> {
        // Get java.lang.Runtime class
        const runtimeClassId = await this.getReferenceTypeId('Ljava/lang/Runtime;');

        // Get the getRuntime() static method ID
        const getRuntimeMethodId = await this.getFirstMethodId(
            runtimeClassId,
            'getRuntime()Ljava/lang/Runtime;'
        );

        // Invoke Runtime.getRuntime()
        const result = await this.invokeStaticMethod(
            runtimeClassId,
            threadId,
            getRuntimeMethodId,
            [],
            0
        );

        if (result.tag !== JDWPTagType.OBJECT || result.value === 0) {
            throw new Error('Failed to get Runtime instance');
        }

        return result.value;
    }

    /*
     * Execute a command inside the VM Runtim namespace
     */
    async exec(threadId: number, cmd: string): Promise<number> {
        // Get runtime instance
        const runtimeId = await this.getRuntime(threadId);

        // Create string with command
        const cmdStringId = await this.createString(cmd);

        // Get runtime class ID for method lookup
        const runtimeClassId = await this.getReferenceTypeId('Ljava/lang/Process;');
        // Get exec method ID
        const execMethodId = await this.getFirstMethodId(
            runtimeClassId,
            'exec(Ljava/lang/String;)Ljava/lang/Process;'
        );

        // Invoke exec method
        const processResult = await this.invokeMethod(
            runtimeId,
            threadId,
            runtimeClassId,
            execMethodId,
            [{ tag: JDWPTagType.STRING, value: cmdStringId }]
        );

        if (processResult.tag !== JDWPTagType.OBJECT) {
            throw new Error('exec() did not return a Process object');
        }

        const processId = processResult.value;

        // Get Process class for waitFor() method
        const processClassId = await this.getReferenceTypeId('Ljava/lang/Process;');
        const waitForMethodId = await this.getFirstMethodId(
            processClassId,
            'waitFor()I'
        );

        // Wait for process to complete
        const exitCodeResult = await this.invokeMethod(
            processId,
            threadId,
            processClassId,
            waitForMethodId,
            []
        );

        if (exitCodeResult.tag !== JDWPTagType.INT) {
            throw new Error('waitFor() did not return an integer');
        }

        const exitCode = exitCodeResult.value;

        if (exitCode !== 0) {
            console.warn(`Command "${cmd}" returned exit code ${exitCode}`);
        }

        return exitCode;
    }


}

