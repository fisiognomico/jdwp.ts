import { Adb } from "@yume-chan/adb";
import { TextDecoderStream, WritableStream } from "@yume-chan/stream-extra";

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

