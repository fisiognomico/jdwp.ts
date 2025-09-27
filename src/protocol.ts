// jdwp-protocol.ts - Core JDWP types and constants
export interface JDWPPacket {
    length: number;
    id: number;
    flags: number;
    commandSet: number;
    command: number;
    data: Uint8Array;
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
    ClassObjectReference = 17,
    Event = 64
}

export enum JDWPVMCommands {
    Version = 1,
    ClassesBySignature = 2,
    AllClasses = 3,
    AllThreads = 4,
    TopLevelThreadGroups = 5,
    Dispose = 6,
    IDSizes = 7,
    Suspend = 8,
    Resume = 9,
    Exit = 10,
    CreateString = 11,
    Capabilities = 12,
    ClassPaths = 13,
    DisposeObjects = 14,
    HoldEvents = 15,
    ReleaseEvents = 16
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

export enum JDWPClassPrepare {
    VERIFIED = 1,
    PREPARED = 2,
    INITIALIZED = 4,
    ERROR = 8
}

export enum JDWPTagType {
    ARRAY = 91,           // '[' - array object
    BYTE = 66,            // 'B' - byte value
    CHAR = 67,            // 'C' - char value
    OBJECT = 76,          // 'L' - object
    FLOAT = 70,           // 'F' - float value
    DOUBLE = 68,          // 'D' - double value
    INT = 73,             // 'I' - int value
    LONG = 74,            // 'J' - long value
    SHORT = 83,           // 'S' - short value
    VOID = 86,            // 'V' - void
    BOOLEAN = 90,         // 'Z' - boolean value
    STRING = 115,         // 's' - string object
    THREAD = 116,         // 't' - thread object
    THREAD_GROUP = 103,   // 'g' - thread group object
    CLASS_LOADER = 108,   // 'l' - class loader object
    CLASS_OBJECT = 99     // 'c' - class object
}

export enum JDWPTypeTag {
    CLASS = 1,
    INTERFACE = 2,
    ARRAY = 3
}

export enum JDWPModifierKind {
    COUNT = 1,
    CONDITIONAL = 2,
    THREAD_ONLY = 3,
    CLASS_ONLY = 4,
    CLASS_MATCH = 5,
    CLASS_EXCLUDE = 6,
    LOCATION_ONLY = 7,
    EXCEPTION_ONLY = 8,
    FIELD_ONLY = 9,
    STEP = 10,
    INSTANCE_ONLY = 11,
    SOURCE_NAME_MATCH = 12
}

export interface EventModifier {
    kind: JDWPModifierKind;
    data: Uint8Array;
}

export enum JDWPInvokeOptions {
    INVOKE_SINGLE_THREADED = 0x01,
    INVOKE_NONVIRTUAL = 0x02
}

export enum JDWPThreadStatus {
    ZOMBIE = 0,
    RUNNING = 1,
    SLEEPING = 2,
    MONITOR = 3,
    WAIT = 4
}

export enum JDWPSuspendStatus {
    SUSPEND_STATUS_SUSPENDED = 0x1
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
    exception?: {
        exceptionId: number;
        catchLocation?: JDWPLocation;
    };
    classId?: number;
    signature?: string;
    fieldId?: number;
    objectId?: number;
    returnValue?: JDWPValue;
    typeId?: number;
    refTypeTag?: number;
    // Reference to JDWPClassStatus
    status?: number;
}


export interface JDWPValue {
    tag: JDWPTagType;
    value: any;  // The actual value depends on the tag
}

export interface JDWPStackFrame {
    frameId: number;
    location: JDWPLocation;
    threadId: number;
}

export interface JDWPLocalVariable {
    codeIndex: number;
    name: string;
    signature: string;
    length: number;
    slot: number;
    isArgument: boolean;
}

export interface JDWPThreadInfo {
    threadId: number;
    name: string;
    status: JDWPThreadStatus;
    suspendStatus: JDWPSuspendStatus;
    suspendCount: number;
    threadGroup?: number;
}

export interface JDWPBreakpoint {
    requestId: number;
    location: JDWPLocation;
    className?: string;
    methodName?: string;
    lineNumber?: number;
    enabled: boolean;
    hitCount?: number;
    condition?: string;
}

export interface JDWPMethodInfo {
    id: number;
    name: string;
    signature: string;
    modifiers: number;
    lineTable?: Array<{
        lineCodeIndex: number;
        lineNumber: number;
    }>;
}

export interface JDWPClassInfo {
    typeId: number;
    signature: string;
    status: number;
    interfaces: number[];
    methods: JDWPMethodInfo[];
    fields: Array<{
        id: number;
        name: string;
        signature: string;
        modifiers: number;
    }>;
}

// Abstract transport layer
export interface JDWPTransport {
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    sendPacket(packet: Uint8Array): Promise<void>;
    onPacket(callback: (packet: Uint8Array) => void): void;
    isConnected(): boolean;
}

// Error codes
export enum JDWPErrorCode {
    NONE = 0,
    INVALID_THREAD = 10,
    INVALID_THREAD_GROUP = 11,
    INVALID_PRIORITY = 12,
    THREAD_NOT_SUSPENDED = 13,
    THREAD_SUSPENDED = 14,
    THREAD_NOT_ALIVE = 15,
    INVALID_OBJECT = 20,
    INVALID_CLASS = 21,
    CLASS_NOT_PREPARED = 22,
    INVALID_METHODID = 23,
    INVALID_LOCATION = 24,
    INVALID_FIELDID = 25,
    INVALID_FRAMEID = 30,
    NO_MORE_FRAMES = 31,
    OPAQUE_FRAME = 32,
    NOT_CURRENT_FRAME = 33,
    TYPE_MISMATCH = 34,
    INVALID_SLOT = 35,
    DUPLICATE = 40,
    NOT_FOUND = 41,
    INVALID_MONITOR = 50,
    NOT_MONITOR_OWNER = 51,
    INTERRUPT = 52,
    INVALID_CLASS_FORMAT = 60,
    CIRCULAR_CLASS_DEFINITION = 61,
    FAILS_VERIFICATION = 62,
    ADD_METHOD_NOT_IMPLEMENTED = 63,
    SCHEMA_CHANGE_NOT_IMPLEMENTED = 64,
    INVALID_TYPESTATE = 65,
    HIERARCHY_CHANGE_NOT_IMPLEMENTED = 66,
    DELETE_METHOD_NOT_IMPLEMENTED = 67,
    UNSUPPORTED_VERSION = 68,
    NAMES_DONT_MATCH = 69,
    CLASS_MODIFIERS_CHANGE_NOT_IMPLEMENTED = 70,
    METHOD_MODIFIERS_CHANGE_NOT_IMPLEMENTED = 71,
    NOT_IMPLEMENTED = 99,
    NULL_POINTER = 100,
    ABSENT_INFORMATION = 101,
    INVALID_EVENT_TYPE = 102,
    ILLEGAL_ARGUMENT = 103,
    OUT_OF_MEMORY = 110,
    ACCESS_DENIED = 111,
    VM_DEAD = 112,
    INTERNAL = 113,
    UNATTACHED_THREAD = 115,
    INVALID_TAG = 500,
    ALREADY_INVOKING = 502,
    INVALID_INDEX = 503,
    INVALID_LENGTH = 504,
    INVALID_STRING = 506,
    INVALID_CLASS_LOADER = 507,
    INVALID_ARRAY = 508,
    TRANSPORT_LOAD = 509,
    TRANSPORT_INIT = 510,
    NATIVE_METHOD = 511,
    INVALID_COUNT = 512
}

