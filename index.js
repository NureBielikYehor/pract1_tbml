import { runCli } from './src/cli.js';

runCli().catch(error => {
  console.error(JSON.stringify({ code: error.code ?? 'ERROR', message: error.message }));
  process.exitCode = 1;
});
