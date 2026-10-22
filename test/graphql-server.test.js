'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMockServer, startMockServer } = require('../lib/server.js');

const SCHEMA = 'type Query { users: [User!]! user(id: ID!): User } type User { id: ID! name: String! }';
const DATA = { users: [{ id: 'u1', name: 'Asha' }, { id: 'u2', name: 'Ravi' }] };

function call(base, method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, base);
    const req = http.request(u, { method: method, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(text || 'null') }));
    });
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body)); else req.end();
  });
}

async function withServer(options, fn) {
  const mock = await startMockServer(Object.assign({ port: 0, token: 't0k', graphql: { schema: SCHEMA, data: DATA } }, options));
  try { await fn(mock, mock.url); } finally { await mock.stop(); }
}

test('POST /graphql runs a query and returns data', async () => {
  await withServer({}, async (mock, base) => {
    const r = await call(base, 'POST', '/graphql', { query: '{ users { id name } }' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { data: { users: [{ id: 'u1', name: 'Asha' }, { id: 'u2', name: 'Ravi' }] } });
  });
});

test('variables and operationName are passed through', async () => {
  await withServer({}, async (mock, base) => {
    const r = await call(base, 'POST', '/graphql', {
      query: 'query A($id: ID!) { user(id: $id) { name } } query B { users { id } }',
      variables: { id: 'u2' }, operationName: 'A',
    });
    assert.deepEqual(r.json, { data: { user: { name: 'Ravi' } } });
  });
});

test('validation errors come back with 400 and no data', async () => {
  await withServer({}, async (mock, base) => {
    const r = await call(base, 'POST', '/graphql', { query: '{ users { nope } }' });
    assert.equal(r.status, 400);
    assert.equal(r.json.errors[0].message, 'Cannot query field "nope" on type "User".');
    assert.equal(r.json.data, undefined);
  });
});

test('execution errors with partial data come back with 200', async () => {
  const data = { users: [{ id: 'u1', name: null }] };
  const mock = await startMockServer({ port: 0, graphql: { schema: 'type Query { users: [User] } type User { id: ID name: String! }', data: data } });
  try {
    const r = await call(mock.url, 'POST', '/graphql', { query: '{ users { id name } }' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data, { users: [null] });
    assert.equal(r.json.errors[0].message, 'Cannot return null for non-nullable field User.name.');
  } finally { await mock.stop(); }
});

test('GET takes the query as a parameter; bad JSON and a missing query are 400', async () => {
  await withServer({}, async (mock, base) => {
    const g = await call(base, 'GET', '/graphql?query=' + encodeURIComponent('{ users { id } }'));
    assert.equal(g.status, 200);
    assert.equal(g.json.data.users.length, 2);
    const none = await call(base, 'POST', '/graphql', { variables: {} });
    assert.equal(none.status, 400);
    assert.match(none.json.errors[0].message, /query/);
  });
});

test('a fault set on the server applies to the GraphQL endpoint too', async () => {
  await withServer({ fault: { type: 'fail-first-n', n: 1, status: 503 } }, async (mock, base) => {
    const first = await call(base, 'POST', '/graphql', { query: '{ users { id } }' });
    assert.equal(first.status, 503);
    const second = await call(base, 'POST', '/graphql', { query: '{ users { id } }' });
    assert.equal(second.status, 200);
  });
});

test('an invalid schema stops startup with a clear message', () => {
  assert.throws(() => createMockServer({ graphql: { schema: 'type User { id: ID }' } }), /Schema must define an object type named Query/);
  assert.throws(() => createMockServer({ graphql: { schema: '' } }), /must hold the schema text/);
  assert.throws(() => createMockServer({ graphql: { schema: SCHEMA, path: 'graphql' } }), /must start with/);
});

test('the endpoint path can be changed', async () => {
  await withServer({ graphql: { schema: SCHEMA, data: DATA, path: '/api/gql' } }, async (mock, base) => {
    assert.equal((await call(base, 'POST', '/api/gql', { query: '{ users { id } }' })).status, 200);
    assert.equal((await call(base, 'POST', '/graphql', { query: '{ users { id } }' })).status, 404);
  });
});

test('mutations change the data for later requests, and reset() restores it', async () => {
  const mock = await startMockServer({ port: 0, graphql: { schema: 'type Query { users: [User!]! } type Mutation { addUser(name: String!): User } type User { id: ID! name: String! }', data: { users: [] }, mutations: { addUser: { insert: 'users' } } } });
  try {
    const add = await call(mock.url, 'POST', '/graphql', { query: 'mutation { addUser(name: "Asha") { id name } }' });
    assert.deepEqual(add.json, { data: { addUser: { id: 'new1', name: 'Asha' } } });
    const list = await call(mock.url, 'POST', '/graphql', { query: '{ users { name } }' });
    assert.deepEqual(list.json, { data: { users: [{ name: 'Asha' }] } });
    mock.reset();
    const after = await call(mock.url, 'POST', '/graphql', { query: '{ users { name } }' });
    assert.deepEqual(after.json, { data: { users: [] } });
  } finally { await mock.stop(); }
});

test('a mutation sent with GET is refused with 405', async () => {
  await withServer({ graphql: { schema: 'type Query { a: Int } type Mutation { b: Int }', data: {}, mutations: { b: { insert: 'x' } } } }, async (mock, base) => {
    const r = await call(base, 'GET', '/graphql?query=' + encodeURIComponent('mutation { b }'));
    assert.equal(r.status, 405);
    assert.equal((await call(base, 'POST', '/graphql', { query: 'mutation { b }' })).status, 200);
  });
});

test('a bad mutation handler stops startup', () => {
  assert.throws(() => createMockServer({ graphql: { schema: 'type Query { a: Int }', mutations: { x: { update: '' } } } }), /exactly one/);
});
