// askpass.js: what git, ssh and sudo run (through the askpass script, with
// Looper's executable as Node) when they need a password, a passphrase or a
// yes. It sends the prompt and its command's token to the Git addon
// (LOOPER_ASKPASS_PIPE), which asks in a window, and prints the answer for the
// program that asked. No answer (the window was closed) exits with 1, which
// makes git, ssh and sudo give up. See askpass.ts.
import { connect } from 'node:net';

const pipe = process.env.LOOPER_ASKPASS_PIPE;
const token = process.env.LOOPER_ASKPASS_TOKEN;
if (!pipe || !token) {
  process.stderr.write("askpass: this program answers git's prompts in Looper, which didn't start it.\n");
  process.exit(1);
}

let buf = '';
let answered = false;
process.exitCode = 1;
const sock = connect(pipe);
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(`${JSON.stringify({ token, prompt: process.argv[2] ?? '' })}\n`));
sock.on('data', (d: string) => {
  if (answered) return;
  buf += d;
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  answered = true;
  let answer: unknown;
  try {
    answer = (JSON.parse(buf.slice(0, nl)) as { answer?: unknown }).answer;
  } catch {
    // Not an answer.
  }
  sock.end();
  if (typeof answer === 'string') {
    process.stdout.write(`${answer}\n`);
    process.exitCode = 0;
  }
});
sock.on('error', (e) => process.stderr.write(`askpass: ${e.message}\n`));
