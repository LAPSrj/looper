// The main process's entry (out/main/index.js): V8's compile cache first, so from the second start on the app's
// code (app.js, from src/main/index.ts) loads already compiled, about half the time. A cache made by another
// Electron's Node isn't used.
import module from 'node:module';
import v8 from 'node:v8';

// The young generation stays at its first size instead of growing to 64 MB. --max-semi-space-size only works on the
// command line, but V8 reads the growth factor each time it would grow.
v8.setFlagsFromString('--semi-space-growth-factor=1');
module.enableCompileCache?.();
module.createRequire(__filename)('./app.js');
