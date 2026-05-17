const fs = require('fs');
const { execSync } = require('child_process');

// Reset files
fs.writeFileSync('runs.json', '[]');
fs.writeFileSync('seen.json', '[]');
fs.writeFileSync('checkpoint.json', '{"reset":true}');

console.log('Files reset');

// Git commands
try {
  execSync('git add -A', { stdio: 'inherit' });
  execSync('git commit -m "RESET: Clear all data"', { stdio: 'inherit' });
  execSync('git push origin main --force', { stdio: 'inherit' });
  console.log('DONE! Check GitHub Actions in 2 minutes.');
} catch (e) {
  console.error('Git error:', e.message);
}
