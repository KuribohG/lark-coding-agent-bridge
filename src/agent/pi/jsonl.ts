import { StringDecoder } from 'node:string_decoder';

/** Pi JSON/RPC framing splits only on LF, including when U+2028 is inside a JSON string. */
export async function* readPiJsonLines(
  stream: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  for await (const chunk of stream) {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
  }
  buffered += decoder.end();
  if (buffered) yield buffered.endsWith('\r') ? buffered.slice(0, -1) : buffered;
}
