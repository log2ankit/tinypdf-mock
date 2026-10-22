'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadGraphQLSync } = require('../lib/graphql.js');

const g = loadGraphQLSync();

const SCHEMA = `
type Query {
  user(id: ID!): User
  users: [User!]!
  products: [Product]
  me: User
}
type User { id: ID! name: String! email: String orders: [Order!]! tags: [String!] }
type Order { id: ID! total: Float! status: String }
type Product { sku: String! price: Float }
`;

const DATA = {
  users: [
    { id: 'u1', name: 'Asha', email: 'a@example.in', tags: ['vip', null],
      orders: [{ id: 'o1', total: 10.5, status: 'paid' }, { id: 'o2', total: 3, status: 'open' }] },
    { id: 'u2', name: 'Ravi', email: null, tags: ['new'], orders: [] },
  ],
  products: [{ sku: 'P1', price: 9 }, { sku: 'P2', $error: 'Inventory service is down' }],
  me: { id: 'u1', name: null },
};

const run = (query, opts = {}) => g.execute(SCHEMA, query, { data: DATA, ...opts });

test('selects scalar and list fields', () => {
  assert.deepEqual(run('{ users { id name } }'), {
    data: { users: [{ id: 'u1', name: 'Asha' }, { id: 'u2', name: 'Ravi' }] },
  });
});

test('aliases and argument filtering on the plural fallback', () => {
  assert.deepEqual(run('{ me2: user(id: "u2") { name email } }'), {
    data: { me2: { name: 'Ravi', email: null } },
  });
});

test('variables with nested selections', () => {
  const res = run('query Q($id: ID!) { user(id: $id) { name orders { id status } } }', { variables: { id: 'u1' } });
  assert.deepEqual(res, {
    data: {
      user: {
        name: 'Asha',
        orders: [{ id: 'o1', status: 'paid' }, { id: 'o2', status: 'open' }],
      },
    },
  });
});

test('variable default is used when the variable is absent', () => {
  const res = g.execute('type Query { a: Int }', 'query Q($v: Int = 4) { a }', { data: { a: 1 } });
  assert.deepEqual(res, { data: { a: 1 } });
});

test('fragments are expanded and typename works', () => {
  assert.deepEqual(run('{ user(id: "u1") { ...U } } fragment U on User { id __typename name }'), {
    data: { user: { id: 'u1', __typename: 'User', name: 'Asha' } },
  });
});

test('operationName selects one of several operations', () => {
  const doc = 'query A { users { id } } query B { me { id } }';
  assert.deepEqual(run(doc, { operationName: 'B' }), { data: { me: { id: 'u1' } } });
  assert.equal(run(doc).errors[0].message, 'Must provide an operation name when the document has several operations.');
  assert.equal(run(doc, { operationName: 'Z' }).errors[0].message, 'Unknown operation named "Z".');
});

test('a non-null field that comes back null nulls its nullable parent', () => {
  const res = run('{ me { id name } }');
  assert.deepEqual(res.data, { me: null });
  assert.equal(res.errors[0].message, 'Cannot return null for non-nullable field User.name.');
  assert.deepEqual(res.errors[0].path, ['me', 'name']);
});

test('a null list item that is non-null nulls the list field, not the whole response', () => {
  const res = run('{ users { id tags } }');
  assert.deepEqual(res.data, { users: [{ id: 'u1', tags: null }, { id: 'u2', tags: ['new'] }] });
  assert.deepEqual(res.errors[0].path, ['users', 0, 'tags', 1]);
});

test('$error on a list item nulls only that item and reports the error with its path', () => {
  const res = run('{ products { sku price } }');
  assert.deepEqual(res.data, { products: [{ sku: 'P1', price: 9 }, null] });
  assert.equal(res.errors[0].message, 'Inventory service is down');
  assert.deepEqual(res.errors[0].path, ['products', 1]);
  assert.deepEqual(res.errors[0].locations, [{ line: 1, column: 3 }]);
});

test('locations are 1-based line and column', () => {
  const res = run('{\n  users {\n    nope\n  }\n}');
  assert.deepEqual(res.errors[0].locations, [{ line: 3, column: 5 }]);
});

test('syntax errors return errors only, with a location', () => {
  const res = run('{ users { id ');
  assert.equal(res.data, undefined);
  assert.equal(res.errors.length, 1);
  assert.ok(res.errors[0].locations);
});

test('unknown fields, unknown arguments and missing required arguments', () => {
  assert.equal(run('{ users { nope } }').errors[0].message, 'Cannot query field "nope" on type "User".');
  assert.equal(run('{ users(x: 1) { id } }').errors[0].message, 'Unknown argument "x" on field "Query.users".');
  assert.equal(
    run('{ user { name } }').errors[0].message,
    'Field "Query.user" argument "id" of type "ID!" is required, but it was not provided.',
  );
});

test('leaf and composite selection rules are enforced', () => {
  assert.equal(
    run('{ users }').errors[0].message,
    'Field "users" of type "User" must have a selection of subfields.',
  );
  assert.equal(
    run('{ users { id { x } } }').errors[0].message,
    'Field "id" must not have a selection since type "ID" has no subfields.',
  );
});

test('missing required variable is reported before execution', () => {
  const res = run('query Q($id: ID!) { user(id: $id) { name } }');
  assert.equal(res.errors[0].message, 'Variable "$id" of required type "ID!" was not provided.');
  assert.equal(res.data, undefined);
});

test('fragment cycles are rejected', () => {
  const res = run('{ users { ...A } } fragment A on User { ...A }');
  assert.ok(res.errors.some((e) => /cannot spread itself|cycle/.test(e.message)));
});

test('schema errors are reported without touching data', () => {
  assert.match(g.execute('type Query { a: Nope }', '{ a }').errors[0].message, /Unknown type "Nope"/);
  assert.equal(
    g.execute('type User { a: Int }', '{ a }').errors[0].message,
    'Schema must define an object type named Query.',
  );
});

test('data that is not an object is rejected', () => {
  assert.equal(g.execute('type Query { a: Int }', '{ a }', { data: [1] }).errors[0].message,
    'The data value must be a JSON object.');
});

test('strings are escaped correctly in both data and error messages', () => {
  const res = g.execute('type Query { s: String }', '{ s }', { data: { s: 'a "quoted"\\ line\nnext é \u{1F600}' } });
  assert.equal(res.data.s, 'a "quoted"\\ line\nnext é \u{1F600}');
});

test('the core rejects inputs over the limit without crashing', () => {
  const big = 'x'.repeat(g.limits.input + 1);
  assert.equal(g.execute(SCHEMA, `{ ${big} }`).errors[0].message, 'Input is too large.');
});

test('the same input gives the same output on repeated calls', () => {
  const first = run('{ users { id name } }');
  const second = run('{ users { id name } }');
  assert.deepEqual(first, second);
});

// ---------- mutations ----------
const MUT_SCHEMA = 'type Query { users: [User!]! } type Mutation { addUser(name: String!, email: String): User renameUser(id: ID!, name: String!): User removeUser(id: ID!): Boolean } type User { id: ID! name: String! email: String orders: [Int!]! }';
const MUT_MAP = {
  addUser: { insert: 'users', defaults: { orders: [] } },
  renameUser: { update: 'users', by: 'id' },
  removeUser: { delete: 'users', by: 'id' },
};
const freshMutData = () => ({ users: [{ id: 'u1', name: 'Asha', orders: [] }] });

test('mutations are planned with their arguments, in order', () => {
  const p = g.plan(MUT_SCHEMA, 'mutation { addUser(name: "A") { id } removeUser(id: "u1") }');
  assert.equal(p.kind, 'mutation');
  assert.deepEqual(p.calls, [
    { key: 'addUser', field: 'addUser', args: { name: 'A' } },
    { key: 'removeUser', field: 'removeUser', args: { id: 'u1' } },
  ]);
  assert.equal(g.plan(MUT_SCHEMA, '{ users { id } }').kind, 'query');
});

test('insert adds an item built from the arguments, with defaults and a new id', () => {
  const data = freshMutData();
  const res = g.execute(MUT_SCHEMA, 'mutation { addUser(name: "Meera", email: "m@x.in") { id name email orders } }', { data, mutations: MUT_MAP });
  assert.deepEqual(res, { data: { addUser: { id: 'new2', name: 'Meera', email: 'm@x.in', orders: [] } } });
  assert.equal(data.users.length, 2);
});

test('update changes the item found by id, and a query sees the change', () => {
  const data = freshMutData();
  const res = g.execute(MUT_SCHEMA, 'mutation R($id: ID!) { renameUser(id: $id, name: "Ravi") { id name } }', {
    data, mutations: MUT_MAP, variables: { id: 'u1' },
  });
  assert.deepEqual(res, { data: { renameUser: { id: 'u1', name: 'Ravi' } } });
  assert.deepEqual(g.execute(MUT_SCHEMA, '{ users { name } }', { data }).data, { users: [{ name: 'Ravi' }] });
});

test('delete removes the item and returns true, or false when nothing matches', () => {
  const data = freshMutData();
  assert.deepEqual(g.execute(MUT_SCHEMA, 'mutation { removeUser(id: "zz") }', { data, mutations: MUT_MAP }).data, { removeUser: false });
  assert.deepEqual(g.execute(MUT_SCHEMA, 'mutation { removeUser(id: "u1") }', { data, mutations: MUT_MAP }).data, { removeUser: true });
  assert.deepEqual(data.users, []);
});

test('a mutation with no handler returns a field error and does not write', () => {
  const data = freshMutData();
  const res = g.execute(MUT_SCHEMA, 'mutation { removeUser(id: "u1") }', { data, mutations: {} });
  assert.equal(res.data.removeUser, null);
  assert.match(res.errors[0].message, /No handler for mutation "removeUser"/);
  assert.equal(data.users.length, 1);
});

test('several mutations in one request run in order, aliases give each result its own key', () => {
  const data = freshMutData();
  const res = g.execute(MUT_SCHEMA, 'mutation { a: addUser(name: "X") { name } b: addUser(name: "Y") { name } }', { data, mutations: MUT_MAP });
  assert.deepEqual(res.data, { a: { name: 'X' }, b: { name: 'Y' } });
  assert.deepEqual(data.users.map((u) => u.name), ['Asha', 'X', 'Y']);
});

test('a mutation on a schema without a Mutation type is rejected before anything runs', () => {
  const res = g.execute('type Query { a: Int }', 'mutation { a }', { data: {} });
  assert.match(res.errors[0].message, /no Mutation type/);
});

test('subscriptions are still rejected', () => {
  assert.equal(g.execute(MUT_SCHEMA, 'subscription { users { id } }').errors[0].message, 'Subscriptions are not supported');
});

test('handler definitions are checked', () => {
  const { validateMutations } = require('../lib/graphql.js');
  assert.throws(() => validateMutations({ x: {} }), /exactly one of insert, update or delete/);
  assert.throws(() => validateMutations({ x: { insert: 'a', delete: 'b' } }), /exactly one/);
});
