const fs = require('fs');

console.log('=== ANALYZING CODEBASE FOR TEST GAPS ===\n');

// 1. Extract all Express endpoints from app.js
const appSource = fs.readFileSync('app.js', 'utf8');
const endpointRegex = /app\.(get|post|put|delete)\s*\(\s*['"]([^'"]+)['"]/g;
const endpoints = [];
let match;
while ((match = endpointRegex.exec(appSource)) !== null) {
  endpoints.push({ method: match[1].toUpperCase(), path: match[2] });
}

console.log('1. EXPRESS ENDPOINTS (' + endpoints.length + ' total)');
console.log('   Currently tested: 2 (/appendVerifiedPost, /gadgetBought)');
console.log('   UNTESTED: ' + (endpoints.length - 2));
endpoints.forEach((ep, i) => {
  const tested = (ep.path === '/appendVerifiedPost' || ep.path === '/gadgetBought');
  console.log('   ' + (i+1) + '. ' + ep.method + ' ' + ep.path + (tested ? ' [TESTED]' : ' [UNTESTED]'));
});

// 2. Extract functions from utils.js
const utilsSource = fs.readFileSync('utils.js', 'utf8');
const utilsFuncRegex = /(?:async\s+)?function\s+(\w+)|(?:let|var|const)\s+(\w+)\s*=\s*(?:async\s+)?function|\bmodule\.exports\.(\w+)\s*=/g;
const utilsFunctions = [];
while ((match = utilsFuncRegex.exec(utilsSource)) !== null) {
  const name = match[1] || match[2] || match[3];
  if (name && !utilsFunctions.includes(name)) utilsFunctions.push(name);
}

console.log('\n2. UTILS.JS FUNCTIONS (' + utilsFunctions.length + ' total)');
console.log('   Currently tested: 0');
console.log('   UNTESTED: ' + utilsFunctions.length);
utilsFunctions.forEach((f, i) => console.log('   ' + (i+1) + '. ' + f + ' [UNTESTED]'));

// 3. Extract functions from mail.js
const mailSource = fs.readFileSync('mail.js', 'utf8');
const mailFuncRegex = /(?:async\s+)?function\s+(\w+)|(?:let|var|const)\s+(\w+)\s*=\s*(?:async\s+)?function|\bmodule\.exports\.(\w+)\s*=/g;
const mailFunctions = [];
while ((match = mailFuncRegex.exec(mailSource)) !== null) {
  const name = match[1] || match[2] || match[3];
  if (name && !mailFunctions.includes(name)) mailFunctions.push(name);
}

console.log('\n3. MAIL.JS FUNCTIONS (' + mailFunctions.length + ' total)');
console.log('   Currently tested: 0');
mailFunctions.forEach((f, i) => console.log('   ' + (i+1) + '. ' + f + ' [UNTESTED]'));

// 4. Extract functions from save-data.js
const saveDataSource = fs.readFileSync('save-data.js', 'utf8');
const saveFuncRegex = /(?:async\s+)?function\s+(\w+)|(?:let|var|const)\s+(\w+)\s*=\s*(?:async\s+)?function|\bmodule\.exports\.(\w+)\s*=/g;
const saveFunctions = [];
while ((match = saveFuncRegex.exec(saveDataSource)) !== null) {
  const name = match[1] || match[2] || match[3];
  if (name && !saveFunctions.includes(name)) saveFunctions.push(name);
}

console.log('\n4. SAVE-DATA.JS FUNCTIONS (' + saveFunctions.length + ' total)');
console.log('   Currently tested: 0');
saveFunctions.forEach((f, i) => console.log('   ' + (i+1) + '. ' + f + ' [UNTESTED]'));

// 5. Identify middleware and auth functions
const middlewareRegex = /(?:let|const|var)\s+(\w+)\s*=\s*\(req,\s*res,\s*next\)\s*=>\s*\{/g;
const middlewares = [];
while ((match = middlewareRegex.exec(appSource)) !== null) {
  middlewares.push(match[1]);
}
console.log('\n5. MIDDLEWARE FUNCTIONS (' + middlewares.length + ' total)');
console.log('   Currently tested: 0');
middlewares.forEach((f, i) => console.log('   ' + (i+1) + '. ' + f + ' [UNTESTED]'));

// 6. Security-sensitive patterns
console.log('\n6. SECURITY-SENSITIVE CODE PATTERNS');
const cryptoCalls = (appSource.match(/crypto\.(createCipher|createDecipher)/g) || []).length;
const jwtCalls = (appSource.match(/jwt\.(sign|verify)/g) || []).length;
const dbCalls = (appSource.match(/db\.collection\(/g) || []).length;
console.log('   Crypto operations (createCipher/createDecipher): ' + cryptoCalls + ' [UNTESTED]');
console.log('   JWT operations (sign/verify): ' + jwtCalls + ' [UNTESTED]');
console.log('   Database collection operations: ' + dbCalls + ' [UNTESTED]');

// 7. External API calls
const axiosCalls = (appSource.match(/axios\.(get|post|put|delete)/g) || []).length;
const axiosCallsUtils = (utilsSource.match(/axios\.(get|post|put|delete)/g) || []).length;
console.log('\n7. EXTERNAL HTTP CALLS');
console.log('   Axios calls in app.js: ' + axiosCalls + ' [UNTESTED]');
console.log('   Axios calls in utils.js: ' + axiosCallsUtils + ' [UNTESTED]');

// 8. Blockchain operations
const hiveCalls = (utilsSource.match(/hive\.(api|broadcast)/g) || []).length;
const steemCalls = (utilsSource.match(/client\.(api|broadcast)/g) || []).length;
const blurtCalls = (utilsSource.match(/blurt\.(api|broadcast)/g) || []).length;
console.log('\n8. BLOCKCHAIN OPERATIONS');
console.log('   Hive API calls: ' + hiveCalls + ' [UNTESTED]');
console.log('   Steem/dsteem API calls: ' + steemCalls + ' [UNTESTED]');
console.log('   Blurt API calls: ' + blurtCalls + ' [UNTESTED]');

console.log('\n=== SUMMARY ===');
const totalUntested = (endpoints.length - 2) + utilsFunctions.length + mailFunctions.length + saveFunctions.length + middlewares.length;
console.log('Total untested functions/endpoints: ' + totalUntested);
console.log('Current test coverage: ~2% (58 tests, mostly library smoke tests)');
console.log('Critical gaps: Authentication, Database queries, Blockchain, Email, Crypto');
