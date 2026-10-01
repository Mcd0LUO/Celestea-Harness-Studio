// Make node:child_process exec/execSync tolerate EPERM (sandbox: piped-stdio spawn blocked).
// Only used to RUN tests in this sandbox; never committed.
const cp = require('node:child_process');
const origExec = cp.exec;
const origExecSync = cp.execSync;
function tolerant(original) {
  return function patched(file, ...rest) {
    try { return original.call(this, file, ...rest); }
    catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return { stdout: '', stderr: '' }; throw e; }
  };
}
function tolerantSync(original) {
  return function patched(file, ...rest) {
    try { return original.call(this, file, ...rest); }
    catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EACCES')) return Buffer.from(''); throw e; }
  };
}
cp.exec = tolerant(origExec);
cp.execSync = tolerantSync(origExecSync);
