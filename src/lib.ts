import { Adb } from "@yume-chan/adb";
import {ReadableStreamDefaultReader, WritableStreamDefaultWriter,
  TextDecoderStream, WritableStream} from "@yume-chan/stream-extra";

export interface ProcessOutput {
  output: string;
  exitCode: number;
}

export async function adbRun(adbClient: Adb, command: string | readonly string[]) : Promise<ProcessOutput> {
  let ret: ProcessOutput = {
    output: "",
    exitCode: 0
  };

  const shell = await adbClient.subprocess.shellProtocol!.spawn(command);
  // Stdout and stderr will generate two Promise, await them together
  await Promise.all([
    shell.stdout.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(chunk) {
         ret.output = chunk;
        },
      }),
    ),
    shell.stderr.pipeThrough(new TextDecoderStream()).pipeTo(
      new WritableStream({
        write(chunk) {
          console.error(["[*] PM LIST ERR ", chunk]);
        },
      }),
    ),
  ]);

  ret.exitCode = await shell.exited;
  return ret;
}

export async function performJDWPHandshake(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>
): Promise<Uint8Array> {
    // Send "JDWP-Handshake"
    const handshakeBytes = new TextEncoder().encode('JDWP-Handshake');
    await writer.write(handshakeBytes);

    // Read response (exactly 14 bytes)
    const response = new Uint8Array(14);
    let offset = 0;
    let extraData = new Uint8Array(0);

    while (offset < 14) {
        const { value, done } = await reader.read();
        if (done) {
            throw new Error('Connection closed during handshake');
        }

        const remaining = 14 - offset;
        const toCopy = Math.min(remaining, value!.length);
        response.set(value!.slice(0, toCopy), offset);
        offset += toCopy;

        // Save any extra data that came with handshake
        if (value!.length > toCopy) {
            extraData = value!.slice(toCopy);
        }
    }

    const responseStr = new TextDecoder().decode(response);
    if (responseStr !== 'JDWP-Handshake') {
        throw new Error(`Invalid JDWP handshake response: ${responseStr}`);
    }

    return extraData; // Return any pending data
}
