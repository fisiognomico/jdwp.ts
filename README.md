# jdwp.ts

A TypeScript implementation of the Java Debug Wire Protocol (JDWP) for debugging Android applications, with first-class support for both WebUSB and ADB server connections.

## Features

- 🔌 **Dual Connection Modes**: WebUSB (browser/desktop) and TCP (Node.js with ADB server)
- 🐛 **Full Debugging Support**: Breakpoints, stepping, variable inspection, thread control
- 📦 **High-Level API**: Simple `DebugManager` interface for common debugging tasks
- 🎯 **Event-Driven**: React to breakpoints and VM events with callbacks
- 🔍 **Stack Inspection**: View stack frames, local variables, and object fields

## Installation

```bash
npm install
```

## Quick Start

### Interactive CLI Debugger (Node.js)

Start an interactive debugging session:

```bash
# Ensure ADB server is running
adb start-server

# Launch the CLI
npm run cli
```

**Example Session:**
```
🔍 JDWP Debugger

✅ Connected to device: emulator-5554

jdwp> list
Debuggable PIDs: 12345, 12346, 12347

jdwp> debug com.example.myapplication
Starting debug session for com.example.myapplication...
Debug session started (PID: 12345)
Breakpoint set at Lcom/example/myapplication/MainActivity;.onCreate

🔴 BREAKPOINT HIT!
   Thread: 1
   com.example.myapplication.MainActivity.onCreate

jdwp> c
Resumed

jdwp> exit
```

### Programmatic Usage

```typescript
import { DebugManager, TCPConfig } from './debug-manager';
import { AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";

// Connect to ADB server
const connector = new AdbServerNodeTcpConnector({
    host: '127.0.0.1',
    port: 5037
});
const serverClient = new AdbServerClient(connector);
const devices = await serverClient.getDevices();

// Create debug manager
const config: TCPConfig = {
    type: 'tcp',
    serverClient,
    deviceSerial: devices[0].serial
};
const debugManager = new DebugManager(config);

// Set up breakpoint handler
debugManager.on('breakpointHit', async (data) => {
    console.log(`Breakpoint hit in thread ${data.threadId}`);
    
    // Inspect local variables
    const frames = await debugManager.getStackFrames(data.session.pid, data.threadId);
    const locals = await debugManager.getLocalVariables(
        data.session.pid,
        data.threadId,
        frames[0].frameId
    );
    
    locals.forEach(v => console.log(`${v.name} = ${v.value}`));
    
    // Resume execution
    await debugManager.resumeThread(data.session.pid, data.threadId);
});

// Start debugging
const session = await debugManager.startDebugging('com.example.myapplication');

// Set breakpoint at method entry
await debugManager.setBreakpoint(
    session.pid,
    'Lcom/example/myapplication/MainActivity;',
    'onCreate'
);
```

**Expected Output:**
```
Debug session started (PID: 12345)
Breakpoint set at MainActivity.onCreate()

Now launch or restart the app to hit the breakpoint...

🔴 Breakpoint hit in MainActivity.onCreate()
Thread ID: 1

Local variables:
  this = { objectId: 67890, type: 'object' }
  savedInstanceState = null
  
Resuming execution...
```

## WebUSB Usage

For browser-based debugging without ADB server:

```typescript
import { DebugManager, WebUSBConfig } from './debug-manager';
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";

// Request device access
const manager = AdbDaemonWebUsbDeviceManager.BROWSER!;
const device = await manager.requestDevice();
const connection = await device.connect();

// Create debug manager
const config: WebUSBConfig = {
    type: 'web',
    serverClient: connection,
    deviceSerial: device.serial,
    adb: await Adb.authenticate({ connection, ... })
};
const debugManager = new DebugManager(config);

// Rest is identical to TCP usage...
```

## API Overview

### DebugManager Methods

```typescript
// Session Management
startDebugging(packageName: string, pid?: number): Promise<DebugSession>
stopDebugging(pid: number): Promise<void>

// Breakpoints
setBreakpoint(pid: number, className: string, methodName: string): Promise<JDWPBreakpoint>
removeBreakpoint(pid: number, requestId: number): Promise<void>
clearAllBreakpoints(pid: number): Promise<void>

// Thread Control
getThreads(pid: number): Promise<JDWPThreadInfo[]>
suspendThread(pid: number, threadId: number): Promise<void>
resumeThread(pid: number, threadId: number): Promise<void>
stepThread(pid: number, threadId: number, stepType: 'into' | 'over' | 'out'): Promise<void>

// Inspection
getStackFrames(pid: number, threadId: number): Promise<JDWPStackFrame[]>
getLocalVariables(pid: number, threadId: number, frameId: number): Promise<VariableInfo[]>
inspectObject(pid: number, objectId: number): Promise<Map<string, any>>

// Utilities
getDebuggablePids(): Promise<number[]>
findAppPid(packageName: string): Promise<number>
```

## Examples

Run the included examples:

```bash
# Debug a specific application
npm run debug:example

# TCP debug test
npm run test:tcp
```

## Architecture

- **Transport Layer**: Abstracts communication (WebUSB or TCP)
- **JDWP Client**: Low-level protocol implementation
- **Debug Manager**: High-level debugging operations
- Built on [ya-webadb](https://github.com/yume-chan/ya-webadb) for ADB connectivity

## Requirements

- Node.js 16+ (for Node.js usage)
- Android device with USB debugging enabled
- ADB server running (for TCP mode)

## License

MIT
