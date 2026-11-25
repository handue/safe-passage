// Runs the API server and Vite together; Ctrl-C stops both.
import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [
  spawn(process.execPath, ['server/index.ts'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

function stopAll(code: number): void {
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) child.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
