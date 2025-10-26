const fs = require('fs');
const path = require('path');

// Remove dist/node folder entirely
const nodeDir = path.join(__dirname, '..', 'dist', 'node');
if (fs.existsSync(nodeDir)) {
  fs.rm(nodeDir, {recursive: true}, (err) => {
    if (err) {
      if (err.code === 'ENOENT') {
        console.error('Directory not found.');
      } else if (err.code === 'ENOTEMPTY') {
        console.error('Directory is not empty.');
      } else {
        console.error('Error removing directory:', err);
      }
    } else {
        console.log('Directory removed successfully!');
    }
  });
  console.log('✓ Removed dist/node/ folder');
}

