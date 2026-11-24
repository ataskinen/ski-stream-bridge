const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const roots = new Set(['.gitignore','LICENSE','README.md','PROTOCOL.md','config.example.json','package.json','package-lock.json','start-mac.sh','start-windows.cmd','publication-files.json']);
function allowed(file) {
  return file === 'docs/images/control-panel.jpg' || roots.has(file) || file === '.github/workflows/ci.yml' || /^(src|scripts|test)\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*\.(cjs|ps1)$/.test(file);
}
function inspect(file, bytes) {
  const errors = [];
  if (!allowed(file)) errors.push('File is outside approved source paths');
  if (bytes.includes(0) || bytes.subarray(0,15).toString() === 'SQLite format 3') errors.push('Binary/database content');
  const text = bytes.toString('utf8');
  for (const [label, re] of [
    ['Personal absolute path', /\/(?:Users|home)\/[A-Za-z0-9._-]+/],
    ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['Credential token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})/],
  ]) if (re.test(text)) errors.push(label);
  return errors;
}
function audit() {
  const { files, imageSha256 } = JSON.parse(fs.readFileSync(path.join(root,'publication-files.json')));
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw Error('Invalid publication manifest');
  const tracked = execFileSync('git',['ls-files','-z'],{cwd:root}).toString().split('\0').filter(Boolean);
  const errors = [];
  for (const file of tracked) if (!files.includes(file)) errors.push(`Tracked file outside manifest: ${file}`);
  for (const file of files) {
    if (!tracked.includes(file)) { errors.push(`Not staged/tracked: ${file}`); continue; }
    if (!allowed(file)) { errors.push(`Forbidden path: ${file}`); continue; }
    const full = path.join(root,file);
    if (file.split('/').some((_,i,a)=>fs.lstatSync(path.join(root,...a.slice(0,i+1))).isSymbolicLink())) { errors.push(`Symlink: ${file}`); continue; }
    const work = fs.readFileSync(full), staged = execFileSync('git',['show',`:${file}`],{cwd:root,maxBuffer:8*1024*1024});
    if (!work.equals(staged)) errors.push(`Working/staged contents differ: ${file}`);
    if (file === 'docs/images/control-panel.jpg') {
      if (crypto.createHash('sha256').update(staged).digest('hex') !== imageSha256 || staged.subarray(0,3).toString('hex') !== 'ffd8ff') errors.push('README image differs from visually reviewed screenshot');
      continue;
    }
    for (const issue of inspect(file,staged)) errors.push(`${file}: ${issue}`);
  }
  if (errors.length) throw Error(errors.join('\n'));
  console.log(`Publication audit passed: ${files.length} approved source/documentation files; no private runtime files.`);
}
if (require.main === module) { try { audit(); } catch (e) { console.error(e.message); process.exitCode=1; } }
module.exports = { allowed, inspect };
