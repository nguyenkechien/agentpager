/**
 * When the reader of our output goes away (`agentpager logs | head`), writes fail with EPIPE and an
 * unhandled stream error would crash with a stack trace. There is nobody left to print to, so exit quietly.
 */
export function exitQuietlyOnBrokenPipe(
  stream: NodeJS.WritableStream,
  exit: () => void = () => {
    process.exit();
  },
): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      exit();
      return;
    }
    throw error;
  });
}
