import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describeMongoUri, maskUri, mongoUriConfigurationIssue } from '../packages/shared/env.js';

test('detects pasted environment assignment and doubled schemes', () => {
  for (const uri of [
    'MONGODB_URI=mongodb+srv://user:secret@cluster.example.net/db',
    'mongodb+srv://MONGODB_URI=mongodb+srv://user:secret@cluster.example.net/db',
    'mongodb+srv://mongodb+srv://user:secret@cluster.example.net/db'
  ]) assert.ok(mongoUriConfigurationIssue(uri));
  assert.equal(mongoUriConfigurationIssue('mongodb+srv://user:pa%40ss@cluster.example.net/db'), null);
});
test('diagnostics never print malformed or correctly formatted secrets', () => {
  for (const uri of ['mongodb+srv://user:secretword@host/db', 'MONGODB_URI=mongodb+srv://user:secretword@host/db', 'mongodb+srv://user:secretword']) {
    assert.equal(maskUri(uri).includes('secretword'),false);
    assert.equal(JSON.stringify(describeMongoUri(uri)).includes('secretword'),false);
  }
  assert.equal(describeMongoUri('mongodb+srv://user:pa/secretword@host/db').host,null);
});
test('startup fails closed and gives the specific duplicate-key fix without exposing credentials', () => {
  const source = "import {connectDB} from './packages/database/store.js'; try {await connectDB(); process.exit(4)} catch(e) {console.error(e.message); process.exit(1)}";
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),env:{...process.env,NODE_ENV:'development',MONGODB_URI:'MONGODB_URI=mongodb+srv://user:secretword@host/db'},encoding:'utf8'});
  assert.equal(result.status,1);
  assert.match(result.stderr,/pasted inside its own value/i);
  assert.doesNotMatch(result.stdout+result.stderr,/secretword/);
});
