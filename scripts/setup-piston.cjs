// Run inside the Piston container: docker compose exec -T piston node < scripts/setup-piston.cjs
// Packages live in the persistent /piston/packages volume. Safe to rerun.
const http = require('http');
const packages = [
  ['python', '3.12.0'],
  ['java', '15.0.2'],
  ['gcc', '10.2.0'], // Provides both C and C++.
  ['node', '20.11.1'],
  ['typescript', '5.0.3'],
];
function request(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request('http://127.0.0.1:2000/api/v2/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      timeout: 600000,
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`${path}: ${res.statusCode} ${data}`));
        try { resolve(JSON.parse(data)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Piston request timed out')));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
(async () => {
  const available = await request('packages');
  for (const [language, version] of packages) {
    const pkg = available.find(p => p.language === language && p.language_version === version);
    if (!pkg) throw new Error(`Package unavailable: ${language} ${version}`);
    if (pkg.installed) { console.log(`Already installed: ${language} ${version}`); continue; }
    console.log(`Installing ${language} ${version}...`);
    await request('packages', { language, version });
    console.log(`Installed ${language} ${version}`);
  }
  const runtimes = await request('runtimes');
  for (const language of ['python', 'java', 'c', 'c++', 'javascript', 'typescript']) {
    if (!runtimes.some(r => r.language === language || r.aliases.includes(language))) {
      throw new Error(`Missing runtime: ${language}`);
    }
  }
  console.log('All six required languages are installed.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
