import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// destroyTab deletes a tab group once it is empty. A route that looks the group up
// and then awaits newPage() can write its tab into a Map that was deleted meanwhile
// (for example by an abandoned create's cleanup), so later calls cannot find the tab.
// Every route must look the group up after the await.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, '../../server.js');

test('no tab group lookup precedes an awaited newPage()', () => {
  const lines = fs.readFileSync(SERVER_PATH, 'utf8').split('\n');
  const offenders = [];
  lines.forEach((line, i) => {
    if (!/await\s+\S*context\.newPage\(\)/.test(line)) return;
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (lines[j].includes('getTabGroup(')) offenders.push(`server.js:${j + 1}: ${lines[j].trim()}`);
    }
  });
  expect(offenders).toEqual([]);
});
