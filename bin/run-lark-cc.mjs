#!/usr/bin/env node
import { runLauncher } from '../dist/launcher.js';
runLauncher(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
