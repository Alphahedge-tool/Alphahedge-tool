import { spawn, execSync } from 'node:child_process';
import net from 'node:net';
import process from 'node:process';

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

function freePort(port) {
  try {
    if (isWin) {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch { /* ignore */ }
      }
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch { /* port already free */ }
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new net.Socket();
      socket.setTimeout(1500);
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      const retry = () => {
        socket.destroy();
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 400);
      };
      socket.once('timeout', retry);
      socket.once('error', retry);
      socket.connect(port, host);
    };
    attempt();
  });
}

const children = [];

function spawnChild(command, args, name) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWin,
    windowsHide: false,
  });
  child.on('exit', code => {
    if (code && code !== 0) {
      console.error(`[start] ${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

async function main() {
  freePort(3001);
  spawnChild(npmCmd, ['run', 'server'], 'server');
  await waitForPort(3001);
  spawnChild(npmCmd, ['run', 'dev', '--', '--host', '0.0.0.0'], 'dev');
}

main().catch(error => {
  console.error(`[start] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
