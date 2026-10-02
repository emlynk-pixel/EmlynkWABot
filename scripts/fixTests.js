const fs = require('fs');

const files = [
  'test/adminRbacAuth.test.js',
  'test/adminInvitation.test.js',
  'test/candidates.test.js'
];

files.forEach(f => {
  if (fs.existsSync(f)) {
    let content = fs.readFileSync(f, 'utf8');
    content = content.replace(/ADMIN_ROLES\.VIEWER/g, '\"VIEWER\"');
    fs.writeFileSync(f, content);
  }
});
console.log("Done");
