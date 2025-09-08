// jdwp-protocol.ts - Core JDWP types and constants
export interface JDWPPacket {
    length: number;
    id: number;
    flags: number;
    commandSet: number;
    command: number;
    data: Uint8Array;
}

export interface JDWPError extends Error {
    code: number;
    packetId: number;
}

export enum JDWPCommandSet {
    VirtualMachine = 1,
    ReferenceType = 2,
    ClassType = 3,
    ArrayType = 4,
    InterfaceType = 5,
    Method = 6,
    Field = 8,
    ObjectReference = 9,
    StringReference = 10,
    ThreadReference = 11,
    ThreadGroupReference = 12,
    ArrayReference = 13,
    ClassLoaderReference = 14,
    EventRequest = 15,
    StackFrame = 16,
    ClassObjectReference = 17
}

export enum JDWPEventKind {
    SINGLE_STEP = 1,
    BREAKPOINT = 2,
    FRAME_POP = 3,
    EXCEPTION = 4,
    USER_DEFINED = 5,
    THREAD_START = 6,
    THREAD_DEATH = 7,
    CLASS_PREPARE = 8,
    CLASS_UNLOAD = 9,
    CLASS_LOAD = 10,
    FIELD_ACCESS = 20,
    FIELD_MODIFICATION = 21,
    EXCEPTION_CATCH = 30,
    METHOD_ENTRY = 40,
    METHOD_EXIT = 41,
    METHOD_EXIT_WITH_RETURN_VALUE = 42,
    MONITOR_CONTENDED_ENTER = 43,
    MONITOR_CONTENDED_ENTERED = 44,
    MONITOR_WAIT = 45,
    MONITOR_WAITED = 46,
    VM_START = 90,
    VM_DEATH = 99,
    VM_DISCONNECTED = 100
}

export enum JDWPSuspendPolicy {
    NONE = 0,
    EVENT_THREAD = 1,
    ALL = 2
}

export enum JDWPStepDepth {
    INTO = 0,
    OVER = 1,
    OUT = 2
}

export enum JDWPStepSize {
    MIN = 0,
    LINE = 1
}

export interface JDWPLocation {
    typeTag: number;
    classId: number;
    methodId: number;
    index: number;
}

export interface JDWPEvent {
    eventKind: JDWPEventKind;
    requestId: number;
    threadId: number;
    location?: JDWPLocation;
    // TODO Additional event-specific fields would be added here
}

// Abstract transport layer
export interface JDWPTransport {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendPacket(packet: Uint8Array): Promise<void>;
    onPacket(callback: (packet: Uint8Array) => void): void;
    isConnected(): boolean;
}

export class JDWPError extends Error {
    constructor(
        public code: number,
        public packetId: number,
        message: string
    ) {
        super(`JDWP Error ${code} (Packet ${packetId}): ${message}`);
        this.name = 'JDWPError';
    }
}

