const fs = require('fs');
const path = require('path');

// Load all JSON files from the scripts/ folder, sorted by filename
const scriptsDir = path.join(__dirname, 'scripts');
const files = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.json')).sort();

const loaded = [];
for (const f of files) {
  try {
    loaded.push(JSON.parse(fs.readFileSync(path.join(scriptsDir, f), 'utf8')));
  } catch (e) {
    console.error(`[scripts] Failed to load ${f}:`, e.message);
  }
}
module.exports = loaded;
