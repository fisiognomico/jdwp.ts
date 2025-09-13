// Most of the content here is taken from
// https://tangoadb.dev/tango/daemon/tcp/create-connection/
// and is needed only to run the node tests!

// First convert node.js's net.socket to TCPSocket
import type { AdbDaemonDevice } from "@yume-chan/adb";
import { AdbPacket, AdbPacketSerializeStream } from "@yume-chan/adb";
import { PromiseResolver } from "@yume-chan/async";
import {
  PushReadableStream,
  tryClose,
  WritableStream,
  StructDeserializeStream,
  Consumable,
  WrapWritableStream,
  type ReadableStream,
} from "@yume-chan/stream-extra";

import { connect, type Socket } from "node:net";

export interface TCPSocketOptions {
  noDelay?: boolean | undefined;
  // Node.js only
  unref?: boolean | undefined;
}

export interface TCPSocketOpenInfo {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  remoteAddress: string;
  remotePort: number;

  localAddress: string;
  localPort: number;
}

export class TCPSocket {
  #socket: Socket;
  #opened = new PromiseResolver<TCPSocketOpenInfo>();
  get opened(): Promise<TCPSocketOpenInfo> {
    return this.#opened.promise;
  }

  constructor(remoteAddress: string, remotePort: number, options?: TCPSocketOptions) {
    this.#socket = connect(remotePort, remoteAddress);

    if (options?.noDelay) {
      this.#socket.setNoDelay(true);
    }
    if (options?.unref) {
      this.#socket.unref();
    }

    this.#socket.on("connect", () => {
      const readable = new PushReadableStream<Uint8Array>((controller) => {
        this.#socket.on("data", async (data) => {
          this.#socket.pause();
          await controller.enqueue(data);
          this.#socket.resume();
        });

        this.#socket.on("end", () => tryClose(controller));

        controller.abortSignal.addEventListener("abort", () => {
          this.#socket.end();
        });
      });

      this.#opened.resolve({
        remoteAddress,
        remotePort,
        localAddress: this.#socket.localAddress!,
        localPort: this.#socket.localPort!,
        readable,
        writable: new WritableStream({
          write: async (chunk) => {
            return new Promise<void>((resolve) => {
              if (!this.#socket.write(chunk)) {
                this.#socket.once("drain", resolve);
              } else {
                resolve();
              }
            });
          },
          close: () => void this.#socket.end(),
        }),
      });
    });

    this.#socket.on("error", (error) => {
      this.#opened.reject(error);
    });
  }
}

export interface AdbDaemonDirectSocketDeviceOptions {
  host: string;
  port?: number;
  name?: string;
  unref?: boolean;
}

export class AdbDaemonDirectSocketsDevice implements AdbDaemonDevice {
  static isSupported(): boolean {
    return true;
  }

  #options: AdbDaemonDirectSocketDeviceOptions;

  readonly serial: string;

  get host(): string {
    return this.#options.host;
  }

  readonly port: number;

  get name(): string | undefined {
    return this.#options.name;
  }

  constructor(options: AdbDaemonDirectSocketDeviceOptions) {
    this.#options = options;
    this.port = options.port ?? 5555;
    this.serial = `${this.host}:${this.port}`;
  }

  async connect() {
    const socket = new TCPSocket(this.host, this.port, {
      noDelay: true,
      unref: this.#options.unref,
    });
    const { readable, writable } = await socket.opened;
    const writer = writable.getWriter();

    return {
      readable: readable.pipeThrough(new StructDeserializeStream(AdbPacket)),
      writable: new WrapWritableStream(
        new Consumable.WritableStream<Uint8Array>({
          write(chunk) {
            return writer.write(chunk);
          },
        }),
      ).bePipedThroughFrom(new AdbPacketSerializeStream()),
    };
  }
}
