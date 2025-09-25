import { JDWPClient } from '../client';
import { JDWPTransport } from '../protocol';
import { events } from '../static/events';

class NullTransport implements JDWPTransport {
    constructor() {}

    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async sendPacket(packet: Uint8Array): Promise<void> {}
    onPacket(callback: (packet: Uint8Array) => void): void {}
    isConnected(): boolean {
        return true;
    }
}

events.forEach( (event) => {
    // A dummy hexdump obtained from wireshark.
    const eventList =  Uint8Array.from(event);

    const transport = new NullTransport();
    const client = new JDWPClient(transport);
    // We do not care about the returned value as everything is made using
    // logging statements
    client.testParseEvent(eventList);
});
