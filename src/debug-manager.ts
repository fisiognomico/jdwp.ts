// debug-manager.ts - High-level debugging manager
import { JDWPClient } from './client';
import { WebUSBJDWPTransport } from './adb-transport';
import {Adb, AdbDaemonConnection, AdbPacketDispatcher, AdbServerClient} from "@yume-chan/adb";
import {
    JDWPCommandSet,
    JDWPEvent,
    JDWPEventKind,
    JDWPBreakpoint,
    JDWPStackFrame,
    JDWPSuspendPolicy,
    JDWPLocalVariable,
    JDWPValue,
    JDWPTagType,
    JDWPThreadInfo,
    JDWPThreadStatus,
    JDWPSuspendStatus,
    JDWPStepSize,
    JDWPStepDepth,
    JDWPVMCommands,
    JDWPTransport
} from './protocol';
import { adbRun } from './lib';

declare const JDWP_BROWSER_BUILD: boolean;

export interface DebugSession {
    pid: number;
    packageName: string;
    client: JDWPClient;
    transport: JDWPTransport;
    breakpoints: Map<number, JDWPBreakpoint>;
    threads: Map<number, JDWPThreadInfo>;
    suspendedThreads: Set<number>;
    currentThread?: number;
    currentFrame?: number;
}

export interface VariableInfo {
    name: string;
    type: string;
    value: any;
    isLocal: boolean;
    slot?: number;
}

// Connection configuration type
export type  ConnectionConfig = WebUSBConfig | TCPConfig;

export type WebUSBConfig = {
    type: 'web';
    serverClient: AdbDaemonConnection;
    deviceSerial: string;
    adb: Adb;
}

export type TCPConfig = {
    type: 'tcp';
    serverClient: AdbServerClient;
    deviceSerial: string;
}

export class DebugManager {
    private sessions: Map<number, DebugSession> = new Map();
    private eventListeners: Map<string, Set<Function>> = new Map();
    private config: ConnectionConfig;
    constructor(config: ConnectionConfig) {
        this.config = config;
    }

    // === Session Management ===

    async startDebugging(packageName: string, pid?: number): Promise<DebugSession> {
        try {
            // Find PID if not provided
            if (!pid) {
                pid = await this.findAppPid(packageName);
            }

            // Check if session already exists
            if (this.sessions.has(pid)) {
                throw new Error(`Debug session already exists for PID ${pid}`);
            }

            // Create transport and client
            const transport = await this.createTransport(pid);
            const client = new JDWPClient(transport);

            // Connect to JDWP
            await client.connect();

            // Create session
            const session: DebugSession = {
                pid,
                packageName,
                client,
                transport,
                breakpoints: new Map(),
                threads: new Map(),
                suspendedThreads: new Set()
            };

            this.sessions.set(pid, session);

            // Initialize session
            await this.initializeSession(session);

            console.log(`Debug session started for ${packageName} (PID: ${pid})`);
            this.emit('sessionStarted', session);

            return session;
        } catch (error) {
            throw new Error(`Failed to start debugging session: ${error}`);
        }
    }

    private async createTransport(pid: number): Promise<JDWPTransport> {
        if (JDWP_BROWSER_BUILD && (this.config.type === 'web')) {
            return new WebUSBJDWPTransport(this.config.adb, pid);
        } else if (this.config.type === 'tcp') {
            const { NodeTcpJDWPTransport } = await import('./node-debug-cli');
            return new NodeTcpJDWPTransport(
                this.config.serverClient,
                this.config.deviceSerial,
                pid
            );
        } else {
            throw new Error(`The configuration ${this.config.type} is not accepted`);
        }
    }

    async stopDebugging(pid: number): Promise<void> {
        const session = this.sessions.get(pid);
        if (!session) {
            throw new Error(`No debug session found for PID ${pid}`);
        }

        try {
            // Clear all breakpoints
            for (const [requestId, breakpoint] of session.breakpoints) {
                try {
                    await session.client.clearBreakpoint(requestId);
                } catch (error) {
                    console.warn(`Failed to clear breakpoint ${requestId}:`, error);
                }
            }

            // Resume all suspended threads
            for (const threadId of session.suspendedThreads) {
                try {
                    await session.client.resumeThread(threadId);
                } catch (error) {
                    console.warn(`Failed to resume thread ${threadId}:`, error);
                }
            }

            // Disconnect
            await session.client.disconnect();

            this.sessions.delete(pid);

            console.log(`Debug session stopped for PID ${pid}`);
            this.emit('sessionStopped', { pid });
        } catch (error) {
            throw new Error(`Failed to stop debugging session: ${error}`);
        }
    }

    async stopAllSessions(): Promise<void> {
        const pids = Array.from(this.sessions.keys());
        for (const pid of pids) {
            await this.stopDebugging(pid);
        }
    }

    // === Breakpoint Management ===

    async setBreakpoint(
        pid: number,
        className: string,
        methodName: string,
        lineNumber: number = 0
    ): Promise<number> {
        const session = this.getSession(pid);

        try {
            // Set the breakpoint
            const requestId = await session.client.setBreakpointAtMethodEntry(
                className,
                methodName
            );

            // Create breakpoint info
            const breakpoint: JDWPBreakpoint = {
                requestId,
                location: {
                    typeTag: 1,
                    classId: 0, // Will be filled when hit
                    methodId: 0, // Will be filled when hit
                    index: 0
                },
                className,
                methodName,
                lineNumber,
                enabled: true,
                hitCount: 0
            };

            session.breakpoints.set(requestId, breakpoint);

            console.log(`Breakpoint set at ${className}.${methodName}`);
            this.emit('breakpointSet', { session, breakpoint });

            return requestId;
        } catch (error) {
            throw new Error(`Failed to set breakpoint: ${error}`);
        }
    }

    async removeBreakpoint(pid: number, requestId: number): Promise<void> {
        const session = this.getSession(pid);

        try {
            await session.client.clearBreakpoint(requestId);
            session.breakpoints.delete(requestId);

            console.log(`Breakpoint ${requestId} removed`);
            this.emit('breakpointRemoved', { session, requestId });
        } catch (error) {
            throw new Error(`Failed to remove breakpoint: ${error}`);
        }
    }

    async toggleBreakpoint(pid: number, requestId: number): Promise<void> {
        const session = this.getSession(pid);
        const breakpoint = session.breakpoints.get(requestId);

        if (!breakpoint) {
            throw new Error(`Breakpoint ${requestId} not found`);
        }

        breakpoint.enabled = !breakpoint.enabled;
        // TODO: Implement enable/disable in JDWP protocol

        this.emit('breakpointToggled', { session, breakpoint });
    }


    async clearAllBreakpoints(pid: number): Promise<void> {
        const session = this.getSession(pid);

        try {
            await session.client.clearAllBreakpoints();
            session.breakpoints.clear();

            console.log('All breakpoints cleared');
            this.emit('allBreakpointsCleared', { session });
        } catch (error) {
            throw new Error(`Failed to clear all breakpoints: ${error}`);
        }
    }

    // === Thread Management ===

    async getThreads(pid: number): Promise<JDWPThreadInfo[]> {
        const session = this.getSession(pid);

        // Get all threads from VM
        const response = await session.client.sendCommand(1, 4, new Uint8Array(0)); // VirtualMachine.AllThreads

        // Parse thread IDs
        const threadCount = this.readUint32(response.data, 0);
        const threads: JDWPThreadInfo[] = [];

        for (let i = 0; i < threadCount; i++) {
            const threadId = this.readObjectId(response.data, 4 + i * 8);
            const threadInfo = await this.getThreadInfo(session, threadId);
            threads.push(threadInfo);
            session.threads.set(threadId, threadInfo);
        }

        return threads;
    }

    async suspendThread(pid: number, threadId: number): Promise<void> {
        const session = this.getSession(pid);

        await session.client.suspendThread(threadId);
        session.suspendedThreads.add(threadId);

        this.emit('threadSuspended', { session, threadId });
    }

    async resumeThread(pid: number, threadId: number): Promise<void> {
        const session = this.getSession(pid);

        await session.client.resumeThread(threadId);
        session.suspendedThreads.delete(threadId);

        this.emit('threadResumed', { session, threadId });
    }

    // Resume execution
    async resume(pid: number): Promise<void> {
        const session = this.getSession(pid);
        await session.client.sendCommand(
            JDWPCommandSet.VirtualMachine,
            JDWPVMCommands.Resume, // ResumeVM
            new Uint8Array(0) // No data is required!
        );
    }

    async stepThread(
        pid: number,
        threadId: number,
        stepType: 'into' | 'over' | 'out' = 'over'
    ): Promise<void> {
        const session = this.getSession(pid);

        const depthMap = {
            'into': JDWPStepDepth.INTO,
            'over': JDWPStepDepth.OVER,
            'out': JDWPStepDepth.OUT
        };

        await session.client.stepThread(
            threadId,
            JDWPStepSize.LINE,
            depthMap[stepType]
        );

        this.emit('threadStepped', { session, threadId, stepType });
    }

    // === Stack and Variables ===

    async getStackFrames(pid: number, threadId: number): Promise<JDWPStackFrame[]> {
        const session = this.getSession(pid);
        return await session.client.getStackFrames(threadId);
    }

    async getLocalVariables(
        pid: number,
        threadId: number,
        frameId: number
    ): Promise<VariableInfo[]> {
        const session = this.getSession(pid);

        const locals = await session.client.getLocalVariables(threadId, frameId);
        const variables: VariableInfo[] = [];

        for (const local of locals) {
            try {
                const value = await session.client.getVariableValue(
                    threadId,
                    frameId,
                    local.slot,
                    this.signatureToTag(local.signature)
                );

                variables.push({
                    name: local.name,
                    type: local.signature,
                    value: await this.formatValue(session, value),
                    isLocal: true,
                    slot: local.slot
                });
            } catch (error) {
                console.warn(`Failed to get value for variable ${local.name}:`, error);
            }
        }

        return variables;
    }

    async inspectObject(pid: number, objectId: number): Promise<Map<string, any>> {
        const session = this.getSession(pid);

        const fields = await session.client.getObjectFields(objectId);
        const result = new Map<string, any>();

        for (const [name, value] of fields) {
            result.set(name, await this.formatValue(session, value));
        }

        return result;
    }

    async evaluateExpression(
        pid: number,
        threadId: number,
        frameId: number,
        expression: string
    ): Promise<any> {
        // This is a simplified implementation
        // A full implementation would need to parse and evaluate Java expressions
        const session = this.getSession(pid);

        // For now, just support simple variable lookup
        const locals = await this.getLocalVariables(pid, threadId, frameId);
        const variable = locals.find(v => v.name === expression);

        if (variable) {
            return variable.value;
        }

        throw new Error(`Expression evaluation not fully implemented: ${expression}`);
    }

    // === Private Helper Methods ===

    private async initializeSession(session: DebugSession): Promise<void> {
        // Set up VM events
        await this.setupVMEvents(session);

        // Get initial thread list
        try {
            await this.getThreads(session.pid);
        } catch (error) {
            console.warn('Failed to get initial thread list:', error);
        }
    }

    private async setupVMEvents(session: DebugSession): Promise<void> {
        try {
            // Set up thread start/death events
            const threadStartData = new Uint8Array(6);
            this.writeUint8(threadStartData, 0, JDWPEventKind.THREAD_START);
            this.writeUint8(threadStartData, 1, JDWPSuspendPolicy.NONE);
            this.writeUint32(threadStartData, 2, 0); // No modifiers

            const threadStartId = await session.client.sendCommand(15, 1, threadStartData);

            // Register handlers for VM events
            session.client.onEvent(0, (event: JDWPEvent) => {
                this.handleVMEvent(session, event);
            });
        } catch(error) {
            console.warn('Failed to get initial thread list:', error);
        }
    }

    private handleBreakpointEvent(
        session: DebugSession,
        breakpoint: JDWPBreakpoint,
        event: JDWPEvent
    ): void {
        if (event.eventKind !== JDWPEventKind.BREAKPOINT) return;

        breakpoint.hitCount = (breakpoint.hitCount || 0) + 1;
        breakpoint.location = event.location!;

        session.currentThread = event.threadId;
        session.suspendedThreads.add(event.threadId);

        console.log(
            `Breakpoint hit at ${breakpoint.className}.${breakpoint.methodName} ` +
            `(thread: ${event.threadId}, hits: ${breakpoint.hitCount})`
        );

        this.emit('breakpointHit', {
            session,
            breakpoint,
            threadId: event.threadId,
            location: event.location
        });
    }

    private handleVMEvent(session: DebugSession, event: JDWPEvent): void {
        switch (event.eventKind) {
            case JDWPEventKind.THREAD_START:
                console.log(`Thread started: ${event.threadId}`);
                this.emit('threadStarted', { session, threadId: event.threadId });
                break;

            case JDWPEventKind.THREAD_DEATH:
                console.log(`Thread ended: ${event.threadId}`);
                session.threads.delete(event.threadId);
                session.suspendedThreads.delete(event.threadId);
                this.emit('threadEnded', { session, threadId: event.threadId });
                break;

            case JDWPEventKind.CLASS_PREPARE:
                console.log(`Class prepared: ${event.signature}`);
                this.emit('classPrepared', { session, signature: event.signature });
                break;

            case JDWPEventKind.VM_DEATH:
                console.log('VM died');
                this.emit('vmDeath', { session });
                this.stopDebugging(session.pid);
                break;
        }
    }

    private async getThreadInfo(session: DebugSession, threadId: number): Promise<JDWPThreadInfo> {
        try {
            // Get thread name
            const nameData = new Uint8Array(8);
            this.writeObjectId(nameData, 0, threadId);

            const nameResponse = await session.client.sendCommand(11, 1, nameData); // ThreadReference.Name
            const nameLength = this.readUint32(nameResponse.data, 0);
            const name = new TextDecoder().decode(nameResponse.data.slice(4, 4 + nameLength));

            // Get thread status
            const statusResponse = await session.client.sendCommand(11, 4, nameData); // ThreadReference.Status
            const status = this.readUint32(statusResponse.data, 0) as JDWPThreadStatus;
            const suspendStatus = this.readUint32(statusResponse.data, 4) as JDWPSuspendStatus;

            // Get suspend count
            const suspendCountResponse = await session.client.sendCommand(11, 12, nameData); // ThreadReference.SuspendCount
            const suspendCount = this.readUint32(suspendCountResponse.data, 0);

            return {
                threadId,
                name,
                status,
                suspendStatus,
                suspendCount
            };
        } catch(error) {
            // Return minimal info if we can't get full details
            console.log(`Error during get thread info for thread ${threadId}: ${error} `);
            return {
                threadId,
                name: `Thread-${threadId}`,
                status: JDWPThreadStatus.RUNNING,
                // TODO this is probably wrong, but the JDWP protocol does
                // not define a suspended status different from suspended.
                suspendStatus: JDWPSuspendStatus.SUSPEND_STATUS_SUSPENDED,
                suspendCount: 0
            };
        }
    }

    private async formatValue(session: DebugSession, value: JDWPValue): Promise<any> {
        switch (value.tag) {
            case JDWPTagType.STRING:
                return await session.client.getStringValue(value.value);

            case JDWPTagType.ARRAY:
                const arrayValues = await session.client.getArrayValues(value.value);
                return await Promise.all(
                    arrayValues.map(v => this.formatValue(session, v))
                );

            case JDWPTagType.OBJECT:
                if (value.value === 0) return null;
                return { objectId: value.value, type: 'object' };

            case JDWPTagType.BOOLEAN:
            case JDWPTagType.BYTE:
            case JDWPTagType.SHORT:
            case JDWPTagType.INT:
            case JDWPTagType.LONG:
            case JDWPTagType.FLOAT:
            case JDWPTagType.DOUBLE:
            case JDWPTagType.CHAR:
                return value.value;

            case JDWPTagType.VOID:
                return undefined;

            default:
                return value.value;
        }
    }

    private signatureToTag(signature: string): JDWPTagType {
        const firstChar = signature[0];
        const tagMap: { [key: string]: JDWPTagType } = {
            'Z': JDWPTagType.BOOLEAN,
            'B': JDWPTagType.BYTE,
            'S': JDWPTagType.SHORT,
            'I': JDWPTagType.INT,
            'J': JDWPTagType.LONG,
            'F': JDWPTagType.FLOAT,
            'D': JDWPTagType.DOUBLE,
            'C': JDWPTagType.CHAR,
            'L': JDWPTagType.OBJECT,
            '[': JDWPTagType.ARRAY,
            'V': JDWPTagType.VOID
        };

        return tagMap[firstChar] || JDWPTagType.OBJECT;
    }

    private getSession(pid: number): DebugSession {
        const session = this.sessions.get(pid);
        if (!session) {
            throw new Error(`No debug session found for PID ${pid}`);
        }
        return session;
    }

    // App management functionalities: get PID of an app and get debuggable
    // apps. These functionalities are provided regardless of how much they
    // are actually compatible with each other.
    // TODO the consequent creation of a transport creates a possible
    // conflict? Ie: 1) Find app PID 2) List debuggable apps
    async getDebuggablePids(): Promise<number[]> {
        if (this.config.type === 'web' ) {
            return await this.getDebuggablePidsWebUSB();
        } else {
            return await this.getDebuggablePidsTCP();
        }
    }

    async findAppPid(packageName: string): Promise<number> {
        if (this.config.type === 'web' ) {
            return await this.findAppPidWebUSB(packageName);
        } else {
            return await this.findAppPidTCP(packageName);
        }
    }

    async executeCommand(command: string): Promise<string[]> {
        if(this.config.type === 'web') {
            return await this.executeCommandWebUSB(command);
        } else {
            return await this.executeCommandTCP(command);
        }
    }

    /**
     * Execute a command inside the app's process using JDWP Runtime.exec()
     * 
     * @param pid Process ID of the debugged app
     * @param command Shell command to execute inside the app
     * @param threadId Optional thread ID to use (defaults to current/first thread)
     * @returns Exit code of the executed command
     */
    async executeJDWP(
        pid: number,
        command: string,
        threadId?: number
    ): Promise<number> {
        const session = this.getSession(pid);

        if(!threadId) {
            if (session.currentThread) {
                threadId = session.currentThread;
            } else {
                const threads = await this.getThreads(pid);
                if (threads.length === 0) {
                    throw new Error('No threads available for execution');
                }
                threadId = threads[0].threadId;
            }
        }

        try {
            const exitCode = await session.client.exec(threadId, command);
            // console.log(`JDWP command completed with exit code: ${exitCode}`);
            return exitCode;
        } catch(error: any) {
            throw new Error(`Failed to execute via JDWP Runtime: ${error}`);
        }
    }

    /**
     * Load a dynamic library using JDWP debug interface
     * @param pid Process ID of the debugged app
     * @param path Full path of the library to be Loaded
     * @param threadId Optional thread ID to use (defaults to current/first thread)
     */
    async loadLibraryJDWP(
        pid: number,
        path: string,
        threadId?: number
    ): Promise<void> {
        const session = this.getSession(pid);

        if(!threadId) {
            if (session.currentThread) {
                threadId = session.currentThread;
            } else {
                const threads = await this.getThreads(pid);
                if (threads.length === 0) {
                    throw new Error("No threads available for execution");
                }
                threadId = threads[0].threadId;
            }
        }

        try {
            await session.client.load(threadId, path);
        } catch (error: any) {
            throw new Error(`Failed to load ${path}: ${error}`);
        }
    }

    private async getDebuggablePidsWebUSB():
        Promise<number[]> {
        const config = this.config as WebUSBConfig;
        const dispatcher = new AdbPacketDispatcher(config.serverClient, {
            calculateChecksum: true,
            appendNullToServiceString: true,
            preserveConnection: false,
            maxPayloadSize: 64 * 1024,
            initialDelayedAckBytes: 0,
        });

        const socket = await dispatcher.createSocket('jdwp');
        const reader = socket.readable.getReader();

        try {
            const { value } = await reader.read();
            if (!value) return [];

            // Skip 4-byte hex length if present
            let data = value;
            const pidsText = new TextDecoder().decode(data).trim();
            if (!pidsText) return [];

            return pidsText
                .split('\n')
                .filter(pid => /^\d+$/.test(pid))
                .map(pid => parseInt(pid, 10));
        } finally {
            await socket.close();
        }
    }


    private async executeCommandWebUSB(command: string): Promise<string[]> {
        const config = this.config as WebUSBConfig;
        try {
            const processDesc = await adbRun(config.adb, command);
            const output = processDesc.output;

            const lines = output.split('\n');
            return lines;

        } catch(error) {
            throw new Error(`Failed to execute ${command}: ${error}`);
        }
    }


    private async findAppPidWebUSB(packageName: string): Promise<number> {
        const config = this.config as WebUSBConfig;
        try {
            // TODO can I grep on the device?
            const processDesc = await adbRun(config.adb, 'ps');
            const output = processDesc.output;

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

    private async getDebuggablePidsTCP(): Promise<number[]> {

        const config = this.config as TCPConfig;
        const deviceSelector = undefined;
        const transport = await config.serverClient.createTransport(deviceSelector);
        const socket = await transport.connect('jdwp');

        try {
            const reader = socket.readable.getReader();
            const { value } = await reader.read();
            if (!value) return [];

            // Skip 4-byte hex length if present
            let data = value;

            const pidsText = new TextDecoder().decode(data).trim();
            if (!pidsText) return [];

            return pidsText
                .split('\n')
                .filter(pid => /^\d+$/.test(pid))
                .map(pid => parseInt(pid, 10));
        } finally {
            await socket.close();
        }
    }

    private async findAppPidTCP(packageName: string): Promise<number> {
        const config = this.config as TCPConfig;
        // Here again, as in NodeTcpJDWPTransport.connect(), we assume that
        // only ONE device is connected to the ADB server!
        try {
            const deviceSelector = undefined;
            const transport = await config.serverClient.createTransport(deviceSelector);

            // TODO maybe move to another function that manages console
            // output?
            const shellCommand = "shell,v2,,raw:ps"
            const socket = await transport.connect(shellCommand);
            const reader = socket.readable.getReader();
            let output = '';

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                output += new TextDecoder().decode(value);
            }

            await socket.close();

            let result = -1;
            const lines = output.split('\n');
            for (const line of lines) {
                if (line.includes(packageName)) {
                    const match = line.match(/^\w+\s+(\d+)/);
                    if (match) {
                        result = parseInt(match[1], 10);
                    } else {
                        console.error(`Failed to find PID for ${packageName}`);
                    }
                }
            }
            return result;
        } catch(error) {
            throw new Error(`Failed to find PID for ${packageName}: ${error}`);
        }

    }

    private async executeCommandTCP(command: string): Promise<string[]> {
        const config = this.config as TCPConfig;
        try {
            const deviceSelector = undefined;
            const transport = await config.serverClient.createTransport(deviceSelector);

            const socket = await transport.connect(command);
            const reader = socket.readable.getReader();
            let output = '';

            while(true) {
                const { value, done } = await reader.read();
                if (done) break;
                output += new TextDecoder().decode(value);
            }

            const lines = output.split('/n');
            await socket.close();
            await transport.close();
            return lines;
        } catch(error) {
            throw new Error(`Failed to execute ${command}: ${error}`);
        }
    }

    // === Event System ===

    private emit(event: string, data: any): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            for (const listener of listeners) {
                try {
                    listener(data);
                } catch (error) {
                    console.error(`Error in event listener for ${event}:`, error);
                }
            }
        }
    }

    on(event: string, listener: Function): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event)!.add(listener);
    }

    off(event: string, listener: Function): void {
        const listeners = this.eventListeners.get(event);
        if (listeners) {
            listeners.delete(listener);
        }
    }

    onEvent(pid: number, requestId: number,
            listener: (event: JDWPEvent) => void): void
    {
        const session = this.sessions.get(pid);
        return session!.client.onEvent(requestId, listener);
    }

    removeEventListener(pid: number, requestId: number): void {
        const session = this.sessions.get(pid);
        return session!.client.removeEventListener(requestId);
    }

    // Binary helpers
    private readUint32(data: Uint8Array, offset: number): number {
        return (data[offset] << 24) |
               (data[offset + 1] << 16) |
               (data[offset + 2] << 8) |
               data[offset + 3];
    }

    private writeUint8(data: Uint8Array, offset: number, value: number): void {
        data[offset] = value;
    }

    private writeUint32(data: Uint8Array, offset: number, value: number): void {
        data[offset] = (value >> 24) & 0xFF;
        data[offset + 1] = (value >> 16) & 0xFF;
        data[offset + 2] = (value >> 8) & 0xFF;
        data[offset + 3] = value & 0xFF;
    }

    private readObjectId(data: Uint8Array, offset: number): number {
        const high = this.readUint32(data, offset);
        const low = this.readUint32(data, offset + 4);
        return (high * 0x100000000) + low;
    }

    private writeObjectId(data: Uint8Array, offset: number, value: number): void {
        const high = Math.floor(value / 0x100000000);
        const low = value % 0x100000000;
        this.writeUint32(data, offset, high);
        this.writeUint32(data, offset + 4, low);
    }
}
